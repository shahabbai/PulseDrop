//! PulseDrop's IPv4 LAN discovery protocol. Pairing codes are never advertised.
use if_addrs::{get_if_addrs, IfAddr};
use serde::{Deserialize, Serialize};
use std::{
    collections::{hash_map::RandomState, HashMap},
    hash::{BuildHasher, Hasher},
    net::{Ipv4Addr, SocketAddr, UdpSocket},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

pub const DISCOVERY_PORT: u16 = 53613;
const MAX_PACKET: usize = 1024;
const MAX_PEERS: usize = 64;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Packet {
    service: String,
    version: u8,
    kind: String,
    nonce: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    receiver: Option<Advertisement>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Advertisement {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub port: u16,
}

#[derive(Debug, Serialize)]
pub struct DiscoveredReceiver {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub ip: String,
    pub port: u16,
}

#[derive(Clone)]
struct Interface {
    ip: Ipv4Addr,
    netmask: Ipv4Addr,
    broadcast: Ipv4Addr,
}

impl Interface {
    fn contains(&self, ip: Ipv4Addr) -> bool {
        u32::from(self.ip) & u32::from(self.netmask) == u32::from(ip) & u32::from(self.netmask)
    }
}

pub fn instance_id() -> String {
    // RandomState obtains independent OS-seeded keys. This is an identity/nonce,
    // never an authentication credential.
    format!(
        "{:016x}{:016x}",
        RandomState::new().build_hasher().finish(),
        RandomState::new().build_hasher().finish()
    )
}

fn interfaces() -> Vec<Interface> {
    let mut result = Vec::new();
    if let Ok(addresses) = get_if_addrs() {
        for address in addresses {
            let IfAddr::V4(v4) = address.addr else {
                continue;
            };
            if !super::is_shareable_ipv4(v4.ip)
                || v4.ip.is_multicast()
                || super::is_vpn_like_interface(&address.name)
                || super::is_virtual_like_interface(&address.name)
                || super::is_mobile_data_interface(&address.name)
            {
                continue;
            }
            let Some(broadcast) = v4.broadcast else {
                continue;
            };
            // A point-to-point or host-only address has no broadcast LAN.
            if u32::from(v4.netmask).count_ones() >= 31 {
                continue;
            }
            result.push(Interface {
                ip: v4.ip,
                netmask: v4.netmask,
                broadcast,
            });
        }
    }
    result.sort_by_key(|interface| interface.ip);
    result.dedup_by_key(|interface| interface.ip);
    result
}

fn query(nonce: &str) -> Packet {
    Packet {
        service: "pulsedrop".into(),
        version: 1,
        kind: "discover".into(),
        nonce: nonce.into(),
        receiver: None,
    }
}

fn decode(bytes: &[u8]) -> Option<Packet> {
    if bytes.len() > MAX_PACKET {
        return None;
    }
    let packet: Packet = serde_json::from_slice(bytes).ok()?;
    if packet.service != "pulsedrop"
        || packet.version != 1
        || packet.nonce.len() != 32
        || !packet.nonce.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return None;
    }
    Some(packet)
}

fn recoverable_receive_error(error: &std::io::Error) -> bool {
    matches!(error.kind(), std::io::ErrorKind::WouldBlock
        | std::io::ErrorKind::TimedOut | std::io::ErrorKind::Interrupted
        | std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionRefused)
        // Winsock reports oversized UDP datagrams as WSAEMSGSIZE instead of
        // returning a truncated packet. They must not stop the responder.
        || error.raw_os_error() == Some(10040)
}

pub struct Responder {
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Responder {
    pub fn start(advertisement: Advertisement) -> Result<Self, String> {
        let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, DISCOVERY_PORT)).map_err(|error| {
            format!("LAN discovery unavailable on UDP {DISCOVERY_PORT}: {error}")
        })?;
        Self::on_socket(socket, advertisement, interfaces)
    }

    fn on_socket(
        socket: UdpSocket,
        advertisement: Advertisement,
        networks: fn() -> Vec<Interface>,
    ) -> Result<Self, String> {
        socket
            .set_read_timeout(Some(Duration::from_millis(100)))
            .map_err(|error| format!("Could not configure LAN discovery: {error}"))?;
        socket
            .set_write_timeout(Some(Duration::from_millis(100)))
            .map_err(|error| format!("Could not configure LAN discovery: {error}"))?;
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let worker = thread::Builder::new()
            .name("lan-discovery".into())
            .spawn(move || responder_loop(socket, advertisement, worker_stop, networks))
            .map_err(|error| format!("Could not start LAN discovery: {error}"))?;
        Ok(Self {
            stop,
            worker: Some(worker),
        })
    }
}

impl Drop for Responder {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn responder_loop(
    socket: UdpSocket,
    advertisement: Advertisement,
    stop: Arc<AtomicBool>,
    network_provider: fn() -> Vec<Interface>,
) {
    let mut buffer = [0; MAX_PACKET + 1];
    let mut networks = network_provider();
    let mut refreshed = Instant::now();
    let mut replies: HashMap<Ipv4Addr, Instant> = HashMap::new();
    while !stop.load(Ordering::Relaxed) {
        if refreshed.elapsed() >= Duration::from_secs(5) {
            networks = network_provider();
            refreshed = Instant::now();
        }
        let (length, source) = match socket.recv_from(&mut buffer) {
            Ok(received) => received,
            Err(error) if recoverable_receive_error(&error) => continue,
            Err(error) => {
                eprintln!("LAN discovery stopped: {error}");
                break;
            }
        };
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let SocketAddr::V4(source_v4) = source else {
            continue;
        };
        if !networks
            .iter()
            .any(|network| network.contains(*source_v4.ip()))
        {
            continue;
        }
        let Some(mut packet) = decode(&buffer[..length]) else {
            continue;
        };
        if packet.kind != "discover" || packet.receiver.is_some() {
            continue;
        }
        // Bound both response traffic and memory in the presence of noisy peers.
        replies.retain(|_, sent| sent.elapsed() < Duration::from_millis(250));
        if replies.len() >= 128 || replies.contains_key(source_v4.ip()) {
            continue;
        }
        replies.insert(*source_v4.ip(), Instant::now());
        packet.kind = "receiver".into();
        packet.receiver = Some(advertisement.clone());
        if let Ok(bytes) = serde_json::to_vec(&packet) {
            if bytes.len() <= MAX_PACKET {
                let _ = socket.send_to(&bytes, source);
            }
        }
    }
}

pub fn discover(own_id: &str) -> Result<Vec<DiscoveredReceiver>, String> {
    scan(
        &interfaces(),
        own_id,
        DISCOVERY_PORT,
        Duration::from_millis(1800),
    )
}

fn parse_receiver(
    bytes: &[u8],
    source: SocketAddr,
    nonce: &str,
    own_id: &str,
) -> Option<DiscoveredReceiver> {
    let packet = decode(bytes)?;
    if packet.kind != "receiver" || packet.nonce != nonce {
        return None;
    }
    let peer = packet.receiver?;
    let SocketAddr::V4(source) = source else {
        return None;
    };
    if peer.id == own_id
        || peer.id.len() != 32
        || !peer.id.bytes().all(|b| b.is_ascii_hexdigit())
        || peer.port == 0
        || peer.name.trim().is_empty()
        || peer.name.len() > 128
        || peer.name.chars().any(char::is_control)
        || peer.platform.is_empty()
        || peer.platform.len() > 32
        || peer.platform.chars().any(char::is_control)
    {
        return None;
    }
    Some(DiscoveredReceiver {
        id: peer.id,
        name: peer.name,
        platform: peer.platform,
        ip: source.ip().to_string(),
        port: peer.port,
    })
}

fn scan(
    networks: &[Interface],
    own_id: &str,
    port: u16,
    timeout: Duration,
) -> Result<Vec<DiscoveredReceiver>, String> {
    if networks.is_empty() {
        return Err("No Wi-Fi or Ethernet IPv4 network found. Connect to a LAN or enter the receiver address manually.".into());
    }
    let mut sockets = Vec::new();
    let mut last_error = String::new();
    for network in networks {
        let setup = || -> std::io::Result<UdpSocket> {
            let socket = UdpSocket::bind((network.ip, 0))?;
            socket.set_broadcast(true)?;
            socket.set_ttl(1)?;
            socket.set_nonblocking(true)?;
            Ok(socket)
        };
        match setup() {
            Ok(socket) => sockets.push((socket, network)),
            Err(error) => last_error = error.to_string(),
        }
    }
    if sockets.is_empty() {
        return Err(format!("Could not scan the LAN: {last_error}"));
    }
    let nonce = instance_id();
    let bytes = serde_json::to_vec(&query(&nonce)).map_err(|error| error.to_string())?;
    let started = Instant::now();
    let mut next_query = Duration::ZERO;
    let mut sent = false;
    let mut peers = HashMap::new();
    let mut buffer = [0; MAX_PACKET + 1];
    while started.elapsed() < timeout {
        if started.elapsed() >= next_query {
            for (socket, network) in &sockets {
                match socket.send_to(&bytes, (network.broadcast, port)) {
                    Ok(_) => sent = true,
                    Err(error) => last_error = error.to_string(),
                }
            }
            next_query += Duration::from_millis(600);
        }
        for (socket, network) in &sockets {
            // Avoid an unbounded receive loop on a busy or hostile network.
            for _ in 0..64 {
                match socket.recv_from(&mut buffer) {
                    Ok((length, source)) => {
                        let SocketAddr::V4(source_v4) = source else {
                            continue;
                        };
                        if source.port() != port || !network.contains(*source_v4.ip()) {
                            continue;
                        }
                        if let Some(peer) =
                            parse_receiver(&buffer[..length], source, &nonce, own_id)
                        {
                            if peers.len() < MAX_PEERS {
                                peers.entry(peer.id.clone()).or_insert(peer);
                            }
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(error) if recoverable_receive_error(&error) => continue,
                    Err(error) => {
                        last_error = error.to_string();
                        break;
                    }
                }
            }
        }
        thread::sleep(Duration::from_millis(25));
    }
    if !sent {
        return Err(format!(
            "Could not send LAN discovery requests: {last_error}"
        ));
    }
    let mut result: Vec<_> = peers.into_values().collect();
    result.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then(a.ip.cmp(&b.ip))
    });
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONCE: &str = "0123456789abcdef0123456789abcdef";
    const PEER_ID: &str = "abcdef0123456789abcdef0123456789";

    fn advertisement() -> Advertisement {
        Advertisement {
            id: PEER_ID.into(),
            name: "Test receiver".into(),
            platform: "windows".into(),
            port: 57123,
        }
    }

    fn reply() -> Packet {
        let mut packet = query(NONCE);
        packet.kind = "receiver".into();
        packet.receiver = Some(advertisement());
        packet
    }

    fn parse(packet: &Packet) -> Option<DiscoveredReceiver> {
        parse_receiver(
            &serde_json::to_vec(packet).unwrap(),
            "192.168.1.42:53613".parse().unwrap(),
            NONCE,
            "own-id",
        )
    }

    fn loopback() -> Vec<Interface> {
        vec![Interface {
            ip: Ipv4Addr::LOCALHOST,
            netmask: Ipv4Addr::new(255, 0, 0, 0),
            broadcast: Ipv4Addr::LOCALHOST,
        }]
    }

    fn responder() -> (Responder, u16) {
        let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = socket.local_addr().unwrap().port();
        (
            Responder::on_socket(socket, advertisement(), loopback).unwrap(),
            port,
        )
    }

    #[test]
    fn resolves_actual_transfer_port_and_source_address_without_pairing_code() {
        let packet = reply();
        let peer = parse(&packet).unwrap();
        assert_eq!(peer.port, 57123);
        assert_eq!(peer.ip, "192.168.1.42");
        let bytes = serde_json::to_string(&packet).unwrap();
        assert!(!bytes.contains("code"));
        assert!(!bytes.contains("inbox"));
    }

    #[test]
    fn rejects_other_protocols_versions_and_scan_nonces() {
        for field in ["service", "version", "kind", "nonce"] {
            let mut packet = reply();
            match field {
                "service" => packet.service = "other-app".into(),
                "version" => packet.version = 2,
                "kind" => packet.kind = "discover".into(),
                _ => packet.nonce = "ffffffffffffffffffffffffffffffff".into(),
            }
            assert!(parse(&packet).is_none(), "accepted wrong {field}");
        }
    }

    #[test]
    fn rejects_self_missing_receiver_invalid_ports_and_untrusted_names() {
        let mut packet = reply();
        let bytes = serde_json::to_vec(&packet).unwrap();
        assert!(parse_receiver(
            &bytes,
            "192.168.1.42:53613".parse().unwrap(),
            NONCE,
            PEER_ID
        )
        .is_none());
        packet.receiver = None;
        assert!(parse(&packet).is_none());
        packet = reply();
        packet.receiver.as_mut().unwrap().port = 0;
        assert!(parse(&packet).is_none());
        for name in ["".to_string(), "a".repeat(129), "bad\nname".into()] {
            packet = reply();
            packet.receiver.as_mut().unwrap().name = name;
            assert!(parse(&packet).is_none());
        }
    }

    #[test]
    fn rejects_malformed_oversized_and_unknown_fields() {
        assert!(decode(b"not json").is_none());
        assert!(decode(&vec![b' '; MAX_PACKET + 1]).is_none());
        let mut value = serde_json::to_value(reply()).unwrap();
        value["receiver"]["code"] = "123456".into();
        assert!(decode(&serde_json::to_vec(&value).unwrap()).is_none());
    }

    #[test]
    fn oversized_windows_packets_and_late_udp_errors_are_recoverable() {
        assert!(recoverable_receive_error(
            &std::io::Error::from_raw_os_error(10040)
        ));
        assert!(recoverable_receive_error(&std::io::Error::from(
            std::io::ErrorKind::ConnectionReset
        )));
        assert!(!recoverable_receive_error(&std::io::Error::from(
            std::io::ErrorKind::PermissionDenied
        )));
    }

    #[test]
    fn subnet_check_uses_the_actual_netmask() {
        let interface = Interface {
            ip: Ipv4Addr::new(172, 16, 5, 4),
            netmask: Ipv4Addr::new(255, 255, 252, 0),
            broadcast: Ipv4Addr::new(172, 16, 7, 255),
        };
        assert!(interface.contains(Ipv4Addr::new(172, 16, 7, 8)));
        assert!(!interface.contains(Ipv4Addr::new(172, 16, 8, 1)));
    }

    #[test]
    fn udp_scan_finds_and_deduplicates_a_live_receiver() {
        let (_responder, port) = responder();
        // More than one request round exercises deduplication, using real UDP sockets.
        let peers = scan(&loopback(), "own-id", port, Duration::from_millis(750)).unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].id, PEER_ID);
        assert_eq!(peers[0].port, 57123);
    }

    #[test]
    fn udp_scan_excludes_our_own_receiver() {
        let (_responder, port) = responder();
        assert!(scan(&loopback(), PEER_ID, port, Duration::from_millis(120))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn stopping_responder_releases_its_port_and_removes_it_from_scans() {
        let (responder, port) = responder();
        drop(responder);
        let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, port)).unwrap();
        drop(socket);
        assert!(
            scan(&loopback(), "own-id", port, Duration::from_millis(120))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn no_network_returns_an_actionable_error() {
        assert!(
            scan(&[], "own-id", DISCOVERY_PORT, Duration::from_millis(1))
                .unwrap_err()
                .contains("No Wi-Fi or Ethernet")
        );
    }
}
