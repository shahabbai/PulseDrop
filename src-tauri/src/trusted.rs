//! Local trust pins Ed25519 keys after users compare a code on both devices.
//! Signed requests authorize resumable transfers over the existing LAN transport.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64, Engine};
use ring::{
    hmac,
    rand::{SecureRandom, SystemRandom},
    signature::{Ed25519KeyPair, KeyPair, UnparsedPublicKey, ED25519},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::State;

const MAX_PENDING: usize = 64;
const MAX_PEERS: usize = 64;
const MAX_PROOFS: usize = 32_768;
const CLOCK_WINDOW: u64 = 90;
const PENDING_TTL: Duration = Duration::from_secs(120);
const ACCEPTED_TTL: Duration = Duration::from_secs(5 * 60);
const MIB: u64 = 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
pub struct Policy {
    pub automatic: bool,
    pub max_mib: u32,
    pub extensions: String,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            automatic: false,
            max_mib: 100,
            extensions: String::new(),
        }
    }
}

impl Policy {
    fn validate(&mut self) -> Result<(), String> {
        if !(1..=1_048_576).contains(&self.max_mib) || self.extensions.len() > 200 {
            return Err("Set a file limit between 1 and 1,048,576 MiB and use up to 200 characters for extensions.".into());
        }
        let mut allowed = Vec::new();
        for ext in self
            .extensions
            .split(',')
            .map(str::trim)
            .filter(|ext| !ext.is_empty())
        {
            let ext = ext.trim_start_matches('.');
            if ext.is_empty() || ext.len() > 16 || !ext.bytes().all(|b| b.is_ascii_alphanumeric()) {
                return Err(
                    "Enter comma-separated filename extensions, such as jpg, png, pdf.".into(),
                );
            }
            allowed.push(ext.to_ascii_lowercase());
        }
        self.extensions = allowed.join(", ");
        Ok(())
    }

    fn allows(&self, name: &str, bytes: u64) -> bool {
        self.automatic
            && bytes <= u64::from(self.max_mib) * MIB
            && (self.extensions.is_empty()
                || name.rsplit_once('.').is_some_and(|(stem, ext)| {
                    !stem.is_empty()
                        && self
                            .extensions
                            .split(", ")
                            .any(|s| s.eq_ignore_ascii_case(ext))
                }))
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Peer {
    pub id: String,
    pub key: String,
    pub name: String,
    pub policy: Policy,
}

#[derive(Clone, Serialize, Deserialize)]
struct Saved {
    private: String,
    peers: Vec<Peer>,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Decision {
    Pending,
    Accepted,
    Declined,
}

struct Pairing {
    key: String,
    name: String,
    expires: Instant,
    decision: Decision,
}

struct Offer {
    key: String,
    file_id: String,
    name: String,
    size: u64,
    expires: Instant,
    decision: Decision,
}

#[derive(Default)]
struct Session {
    challenge: String,
    proofs: HashMap<String, Instant>,
    pairings: HashMap<String, Pairing>,
    offers: HashMap<String, Offer>,
}

pub struct Store {
    path: PathBuf,
    key: Ed25519KeyPair,
    public: String,
    pub id: String,
    storage_key: hmac::Key,
    saved: Mutex<Saved>,
    session: Mutex<Session>,
}

pub struct Local(pub Result<Store, String>);

impl Local {
    pub fn store(&self) -> Result<&Store, String> {
        self.0.as_ref().map_err(Clone::clone)
    }
}

pub fn random<const N: usize>() -> Result<[u8; N], String> {
    let mut data = [0; N];
    SystemRandom::new()
        .fill(&mut data)
        .map_err(|_| "Secure randomness is unavailable.")?;
    Ok(data)
}

fn hash(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

fn peer_id(key: &str) -> String {
    hash(key.as_bytes())[..32].into()
}

fn decode<const N: usize>(value: &str) -> Option<[u8; N]> {
    if value.len() != (N * 8).div_ceil(6) {
        return None;
    }
    let decoded: [u8; N] = BASE64.decode(value).ok()?.try_into().ok()?;
    (BASE64.encode(decoded) == value).then_some(decoded)
}

fn proof_id(value: &str) -> bool {
    decode::<16>(value).is_some()
}

fn request_message(method: &str, target: &str) -> String {
    format!("PulseDrop trust request v1\n{method}\n{target}")
}

fn reply_message(nonce: &str, status: u16, body: &str) -> String {
    format!("PulseDrop trust reply v1\n{nonce}\n{status}\n{body}")
}

fn fingerprint(sender: &str, receiver: &str, id: &str) -> String {
    let hash = hash(format!("PulseDrop pairing v1\n{sender}\n{receiver}\n{id}").as_bytes());
    format!(
        "{} {} {} {}",
        &hash[..4],
        &hash[4..8],
        &hash[8..12],
        &hash[12..16]
    )
    .to_ascii_uppercase()
}

fn verify(key: &str, message: &str, proof: &str) -> bool {
    let (Some(key), Some(proof)) = (decode::<32>(key), decode::<64>(proof)) else {
        return false;
    };
    UnparsedPublicKey::new(&ED25519, key)
        .verify(message.as_bytes(), &proof)
        .is_ok()
}

fn stage_saved(path: &Path, saved: &Saved) -> Result<tempfile::NamedTempFile, String> {
    let parent = path.parent().ok_or("Missing trusted-device directory.")?;
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|err| err.to_string())?;
    serde_json::to_writer(temp.as_file_mut(), saved).map_err(|err| err.to_string())?;
    temp.as_file_mut()
        .flush()
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|err| err.to_string())?;
    Ok(temp)
}

impl Store {
    pub fn open(path: PathBuf) -> Result<Self, String> {
        let saved: Saved = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|err| err.to_string())?,
            Err(err) if err.kind() == ErrorKind::NotFound => {
                let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
                    .map_err(|_| "Could not generate the device identity.")?;
                let saved = Saved {
                    private: BASE64.encode(pkcs8.as_ref()),
                    peers: Vec::new(),
                };
                match stage_saved(&path, &saved)?.persist_noclobber(&path) {
                    Ok(_) => saved,
                    Err(err) if err.error.kind() == ErrorKind::AlreadyExists => {
                        let bytes = fs::read(&path).map_err(|err| err.to_string())?;
                        serde_json::from_slice(&bytes).map_err(|err| err.to_string())?
                    }
                    Err(err) => return Err(err.to_string()),
                }
            }
            Err(err) => return Err(err.to_string()),
        };
        let private = BASE64
            .decode(&saved.private)
            .map_err(|_| "Invalid device identity.")?;
        let key = Ed25519KeyPair::from_pkcs8(&private).map_err(|_| "Invalid device identity.")?;
        let public = BASE64.encode(key.public_key().as_ref());
        Ok(Self {
            path,
            key,
            id: peer_id(&public),
            public,
            storage_key: hmac::Key::new(hmac::HMAC_SHA256, &private),
            saved: Mutex::new(saved),
            session: Mutex::new(Session::default()),
        })
    }

    fn change_peers(
        &self,
        change: impl FnOnce(&mut Vec<Peer>) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut saved = self.saved.lock().unwrap();
        let mut next = saved.clone();
        change(&mut next.peers)?;
        stage_saved(&self.path, &next)?
            .persist(&self.path)
            .map_err(|err| err.to_string())?;
        *saved = next;
        Ok(())
    }

    fn remember(&self, key: &str, name: &str) -> Result<(), String> {
        if key == self.public || decode::<32>(key).is_none() {
            return Err("Invalid trusted-device identity.".into());
        }
        let name = super::normalized_device_name(name).ok_or("Invalid device name.")?;
        self.change_peers(|peers| {
            if let Some(peer) = peers.iter_mut().find(|peer| peer.key == key) {
                peer.name = name;
            } else {
                if peers.len() >= MAX_PEERS {
                    return Err("Forget a trusted device before adding another.".into());
                }
                peers.push(Peer {
                    id: peer_id(key),
                    key: key.into(),
                    name,
                    policy: Policy::default(),
                });
            }
            Ok(())
        })
    }

    pub fn peer(&self, key: &str) -> Option<Peer> {
        self.saved
            .lock()
            .unwrap()
            .peers
            .iter()
            .find(|peer| peer.key == key)
            .cloned()
    }

    pub fn start(&self) -> Result<(), String> {
        *self.session.lock().unwrap() = Session {
            challenge: BASE64.encode(random::<16>()?),
            ..Session::default()
        };
        Ok(())
    }

    pub fn stop(&self) {
        *self.session.lock().unwrap() = Session::default();
    }

    fn sign(&self, message: &str) -> String {
        BASE64.encode(self.key.sign(message.as_bytes()).as_ref())
    }

    pub fn sign_reply(&self, nonce: &str, status: u16, body: &str) -> String {
        self.sign(&reply_message(nonce, status, body))
    }

    pub fn info(&self) -> serde_json::Value {
        serde_json::json!({
            "key": self.public,
            "id": self.id,
            "challenge": self.session.lock().unwrap().challenge,
        })
    }

    pub fn scoped_id(&self, key: &str, file_id: &str) -> String {
        let digest = hmac::sign(
            &self.storage_key,
            format!("PulseDrop trusted file v1\n{key}\n{file_id}").as_bytes(),
        );
        digest.as_ref()[..16]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    pub fn authenticate<'a>(
        &self,
        method: &str,
        target: &str,
        query: &'a HashMap<String, String>,
    ) -> Option<Proof<'a>> {
        let (unsigned, signature) = target.rsplit_once("&proof=")?;
        let field = |name: &str| query.get(name).map(String::as_str);
        let sender = field("sender")?;
        let nonce = field("nonce")?;
        let challenge = field("challenge")?;
        let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
        let sent: u64 = field("time")?.parse().ok()?;
        if field("receiver")? != self.public
            || !proof_id(nonce)
            || now.abs_diff(sent) > CLOCK_WINDOW
            || !verify(sender, &request_message(method, unsigned), signature)
        {
            return None;
        }
        let mut session = self.session.lock().unwrap();
        if session.challenge.is_empty() || challenge != session.challenge {
            return None;
        }
        let instant = Instant::now();
        session.proofs.retain(|_, expires| *expires > instant);
        if session.proofs.len() >= MAX_PROOFS || session.proofs.contains_key(nonce) {
            return None;
        }
        session.proofs.insert(
            nonce.into(),
            instant + Duration::from_secs(CLOCK_WINDOW * 2 + 1),
        );
        Some(Proof {
            sender,
            nonce,
            challenge,
        })
    }

    pub fn pair_request(
        &self,
        key: &str,
        id: &str,
        name: &str,
        challenge: &str,
    ) -> Result<(), String> {
        let name = super::normalized_device_name(name).ok_or("Invalid device name.")?;
        if key == self.public {
            return Err("Choose a different device to pair.".into());
        }
        let mut session = self.session.lock().unwrap();
        session.sweep();
        if challenge != session.challenge {
            return Err("The receiver restarted. Pair again.".into());
        }
        if session.pairings.len() >= MAX_PENDING {
            return Err("Too many pairing requests. Try again shortly.".into());
        }
        session.pairings.insert(
            id.into(),
            Pairing {
                key: key.into(),
                name,
                expires: Instant::now() + PENDING_TTL,
                decision: Decision::Pending,
            },
        );
        Ok(())
    }

    pub fn pair_status(&self, key: &str, id: &str) -> Option<serde_json::Value> {
        let mut session = self.session.lock().unwrap();
        session.sweep();
        let pairing = session
            .pairings
            .get(id)
            .filter(|pairing| pairing.key == key)?;
        Some(serde_json::json!({ "decision": pairing.decision }))
    }

    pub fn offer_file(
        &self,
        key: &str,
        offer_id: &str,
        file_id: &str,
        name: &str,
        size: u64,
        challenge: &str,
    ) -> Result<serde_json::Value, String> {
        if !proof_id(offer_id)
            || !crate::resume::valid_id(file_id)
            || name.is_empty()
            || name.len() > 512
        {
            return Err("Invalid file offer.".into());
        }
        let mut session = self.session.lock().unwrap();
        session.sweep();
        if challenge != session.challenge {
            return Err("The receiver restarted. Send the file again.".into());
        }
        let peer = self.peer(key).ok_or("This device is no longer trusted.")?;
        if session.offers.len() >= MAX_PENDING || session.offers.contains_key(offer_id) {
            return Err("Too many active file requests. Try again shortly.".into());
        }
        let automatic = peer.policy.allows(name, size);
        let decision = if automatic {
            Decision::Accepted
        } else {
            Decision::Pending
        };
        session.offers.insert(
            offer_id.into(),
            Offer {
                key: key.into(),
                file_id: file_id.into(),
                name: name.into(),
                size,
                decision,
                expires: Instant::now() + if automatic { ACCEPTED_TTL } else { PENDING_TTL },
            },
        );
        Ok(serde_json::json!({ "decision": decision }))
    }

    pub fn file_status(&self, key: &str, id: &str) -> Option<serde_json::Value> {
        self.peer(key)?;
        let mut session = self.session.lock().unwrap();
        session.sweep();
        let offer = session.offers.get(id).filter(|offer| offer.key == key)?;
        Some(serde_json::json!({ "decision": offer.decision }))
    }

    pub fn allow_chunk(
        &self,
        key: &str,
        id: &str,
        file_id: &str,
        metadata: Option<(&str, u64)>,
        challenge: &str,
    ) -> bool {
        let mut session = self.session.lock().unwrap();
        if challenge != session.challenge || self.peer(key).is_none() {
            return false;
        }
        session.sweep();
        let Some(offer) = session.offers.get_mut(id) else {
            return false;
        };
        if offer.key != key
            || offer.file_id != file_id
            || offer.decision != Decision::Accepted
            || metadata.is_some_and(|(name, size)| offer.name != name || offer.size != size)
        {
            return false;
        }
        offer.expires = Instant::now() + ACCEPTED_TTL;
        true
    }

    pub fn finish_offer(&self, key: &str, id: &str, file_id: &str) {
        let mut session = self.session.lock().unwrap();
        if session
            .offers
            .get(id)
            .is_some_and(|offer| offer.key == key && offer.file_id == file_id)
        {
            session.offers.remove(id);
        }
    }

    fn decide(&self, id: &str, kind: &str, accept: bool) -> Result<(), String> {
        let mut session = self.session.lock().unwrap();
        session.sweep();
        let decision = if accept {
            Decision::Accepted
        } else {
            Decision::Declined
        };
        if kind == "pair" {
            let request = session
                .pairings
                .get_mut(id)
                .filter(|request| request.decision == Decision::Pending)
                .ok_or("This pairing request expired.")?;
            if accept {
                self.remember(&request.key, &request.name)?;
            }
            request.decision = decision;
        } else if kind == "file" {
            let request = session
                .offers
                .get_mut(id)
                .filter(|request| request.decision == Decision::Pending)
                .ok_or("This file request expired.")?;
            if accept && self.peer(&request.key).is_none() {
                return Err("This device is no longer trusted.".into());
            }
            request.decision = decision;
            if accept {
                request.expires = Instant::now() + ACCEPTED_TTL;
            }
        } else {
            return Err("Unknown request.".into());
        }
        Ok(())
    }

    fn set_policy(&self, id: &str, mut policy: Policy) -> Result<(), String> {
        policy.validate()?;
        self.change_peers(|peers| {
            let peer = peers
                .iter_mut()
                .find(|peer| peer.id == id)
                .ok_or("This device is no longer trusted.")?;
            peer.policy = policy;
            Ok(())
        })
    }

    fn forget(&self, id: &str) -> Result<(), String> {
        let mut session = self.session.lock().unwrap();
        self.change_peers(|peers| {
            peers.retain(|peer| peer.id != id);
            Ok(())
        })?;
        session.offers.retain(|_, offer| peer_id(&offer.key) != id);
        session
            .pairings
            .retain(|_, pairing| peer_id(&pairing.key) != id);
        Ok(())
    }
}

impl Session {
    fn sweep(&mut self) {
        let now = Instant::now();
        self.pairings.retain(|_, request| request.expires > now);
        self.offers.retain(|_, request| request.expires > now);
    }
}

pub struct Proof<'a> {
    pub sender: &'a str,
    pub nonce: &'a str,
    pub challenge: &'a str,
}

#[tauri::command]
pub fn trusted_snapshot(state: State<'_, Local>) -> Result<serde_json::Value, String> {
    let store = state.store()?;
    let mut session = store.session.lock().unwrap();
    session.sweep();
    let peers = store.saved.lock().unwrap().peers.clone();
    let mut pending = Vec::new();
    for (id, request) in session
        .pairings
        .iter()
        .filter(|(_, p)| p.decision == Decision::Pending)
    {
        pending.push(serde_json::json!({
            "id": id, "kind": "pair", "device": request.name,
            "code": fingerprint(&request.key, &store.public, id),
        }));
    }
    for (id, request) in session
        .offers
        .iter()
        .filter(|(_, o)| o.decision == Decision::Pending)
    {
        if let Some(peer) = peers.iter().find(|peer| peer.key == request.key) {
            pending.push(serde_json::json!({
                "id": id, "kind": "file", "device": peer.name,
                "name": request.name, "size": request.size,
            }));
        }
    }
    pending.sort_by_cached_key(|request| request["id"].as_str().unwrap_or_default().to_owned());
    Ok(serde_json::json!({ "key": store.public, "peers": peers, "pending": pending }))
}

#[tauri::command]
pub fn trusted_sign(state: State<'_, Local>, method: &str, target: &str) -> Result<String, String> {
    Ok(state.store()?.sign(&request_message(method, target)))
}

#[tauri::command]
pub fn trusted_verify(key: &str, nonce: &str, status: u16, body: &str, proof: &str) -> bool {
    verify(key, &reply_message(nonce, status, body), proof)
}

#[tauri::command]
pub fn trusted_pair_code(state: State<'_, Local>, key: &str, id: &str) -> Result<String, String> {
    if !proof_id(id) || decode::<32>(key).is_none() {
        return Err("Invalid pairing response.".into());
    }
    Ok(fingerprint(&state.store()?.public, key, id))
}

#[tauri::command]
pub fn trusted_remember(state: State<'_, Local>, key: &str, name: &str) -> Result<(), String> {
    state.store()?.remember(key, name)
}

#[tauri::command]
pub fn trusted_decide(
    state: State<'_, Local>,
    id: &str,
    kind: &str,
    accept: bool,
) -> Result<(), String> {
    state.store()?.decide(id, kind, accept)
}

#[tauri::command]
pub fn trusted_set_policy(state: State<'_, Local>, id: &str, policy: Policy) -> Result<(), String> {
    state.store()?.set_policy(id, policy)
}

#[tauri::command]
pub fn trusted_forget(state: State<'_, Local>, id: &str) -> Result<(), String> {
    state.store()?.forget(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stores(dir: &Path) -> (Store, Store) {
        (
            Store::open(dir.join("sender.json")).unwrap(),
            Store::open(dir.join("receiver.json")).unwrap(),
        )
    }

    #[test]
    fn proves_identity_and_rejects_tampering_replay_stale_time_and_previous_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let (sender, receiver) = stores(dir.path());
        receiver.start().unwrap();
        let challenge = receiver.session.lock().unwrap().challenge.clone();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let target = |when: u64| {
            let nonce = BASE64.encode(random::<16>().unwrap());
            let unsigned = format!("/trust/chunk?offset=0&sender={}&receiver={}&nonce={nonce}&challenge={challenge}&time={when}", sender.public, receiver.public);
            format!(
                "{unsigned}&proof={}",
                sender.sign(&request_message("POST", &unsigned))
            )
        };
        let valid = target(now);
        let check = |method: &str, target: &str| {
            receiver
                .authenticate(method, target, &crate::parse_target(target).1)
                .is_some()
        };
        assert!(!check("GET", &valid));
        assert!(!check("POST", &valid.replace("offset=0", "offset=8")));
        assert!(check("POST", &valid));
        assert!(!check("POST", &valid));
        assert!(!check("POST", &target(now - CLOCK_WINDOW - 1)));
        let old = target(now);
        receiver.start().unwrap();
        assert!(!check("POST", &old));
        let reply = receiver.sign_reply("nonce", 200, "accepted");
        assert!(verify(
            &receiver.public,
            &reply_message("nonce", 200, "accepted"),
            &reply
        ));
        assert!(!verify(
            &receiver.public,
            &reply_message("nonce", 200, "declined"),
            &reply
        ));
        assert!(!verify(
            &sender.public,
            &reply_message("nonce", 200, "accepted"),
            &reply
        ));
    }

    #[test]
    fn pairing_requires_receiver_approval_and_identity_and_policy_survive_restart() {
        let dir = tempfile::tempdir().unwrap();
        let (sender, receiver) = stores(dir.path());
        receiver.start().unwrap();
        let challenge = receiver.session.lock().unwrap().challenge.clone();
        let id = BASE64.encode(random::<16>().unwrap());
        receiver
            .pair_request(&sender.public, &id, "Laptop", &challenge)
            .unwrap();
        assert_eq!(
            receiver.pair_status(&sender.public, &id).unwrap()["decision"],
            "pending"
        );
        assert!(receiver.peer(&sender.public).is_none());
        assert!(receiver.pair_status(&receiver.public, &id).is_none());
        receiver.decide(&id, "pair", true).unwrap();
        assert_eq!(
            receiver.pair_status(&sender.public, &id).unwrap()["decision"],
            "accepted"
        );
        assert!(!receiver.peer(&sender.public).unwrap().policy.automatic);

        receiver
            .set_policy(
                &sender.id,
                Policy {
                    automatic: true,
                    max_mib: 10,
                    extensions: ".Pdf, JPG".into(),
                },
            )
            .unwrap();
        let reopened = Store::open(receiver.path.clone()).unwrap();
        assert_eq!(reopened.id, receiver.id);
        let peer = reopened.peer(&sender.public).unwrap();
        assert_eq!(peer.name, "Laptop");
        assert_eq!(peer.policy.extensions, "pdf, jpg");
        assert!(peer.policy.allows("report.PDF", 10 * MIB));
        assert!(!peer.policy.allows("report.pdf.exe", MIB));
        assert!(!peer.policy.allows("report.pdf", 10 * MIB + 1));
    }

    #[test]
    fn trusted_grants_scope_the_file_and_manual_restrictions_and_forgetting_revokes_them() {
        let dir = tempfile::tempdir().unwrap();
        let (sender, receiver) = stores(dir.path());
        let other = Store::open(dir.path().join("other.json")).unwrap();
        receiver.start().unwrap();
        let challenge = receiver.session.lock().unwrap().challenge.clone();
        let file_id = "ba0ec63a0a3a43b9aac5f503198200fa";
        let id = BASE64.encode(random::<16>().unwrap());
        assert!(receiver
            .offer_file(&sender.public, &id, file_id, "report.pdf", 7, &challenge)
            .is_err());
        receiver.remember(&sender.public, "Phone").unwrap();
        receiver.remember(&other.public, "Other").unwrap();
        receiver
            .set_policy(
                &sender.id,
                Policy {
                    automatic: true,
                    max_mib: 1,
                    extensions: "jpg".into(),
                },
            )
            .unwrap();
        assert_eq!(
            receiver
                .offer_file(&sender.public, &id, file_id, "report.pdf", 7, &challenge)
                .unwrap()["decision"],
            "pending"
        );
        assert!(!receiver.allow_chunk(&sender.public, &id, file_id, None, &challenge));
        receiver.decide(&id, "file", true).unwrap();
        assert!(receiver.allow_chunk(
            &sender.public,
            &id,
            file_id,
            Some(("report.pdf", 7)),
            &challenge
        ));
        assert!(!receiver.allow_chunk(
            &sender.public,
            &id,
            file_id,
            Some(("report.pdf", 8)),
            &challenge
        ));
        assert!(!receiver.allow_chunk(
            &sender.public,
            &id,
            file_id,
            Some(("other.pdf", 7)),
            &challenge
        ));
        assert!(!receiver.allow_chunk(&other.public, &id, file_id, None, &challenge));
        assert_ne!(
            receiver.scoped_id(&sender.public, file_id),
            receiver.scoped_id(&other.public, file_id)
        );
        receiver.finish_offer(&sender.public, &id, file_id);
        assert!(receiver.file_status(&sender.public, &id).is_none());
        assert_eq!(
            receiver
                .offer_file(&sender.public, &id, file_id, "photo.JPG", 7, &challenge)
                .unwrap()["decision"],
            "accepted"
        );
        receiver.forget(&sender.id).unwrap();
        assert!(!receiver.allow_chunk(&sender.public, &id, file_id, None, &challenge));
        assert!(Store::open(receiver.path.clone())
            .unwrap()
            .peer(&sender.public)
            .is_none());
    }
}
