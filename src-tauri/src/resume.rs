use crate::{
    receive::{Phase, Progress},
    transfers::Control,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

pub const CHUNK: u64 = 4 * 1024 * 1024;
const EMPTY_DIGEST: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const MAX_RECORDS: usize = 256;

pub fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn root(inbox: &Path) -> PathBuf {
    inbox.join(".pulsedrop-resume")
}

#[derive(Deserialize, Serialize)]
struct Checkpoint {
    name: String,
    size: u64,
    offset: u64,
    digest: String,
    destination: Option<String>,
    cancelled: bool,
}

#[derive(Serialize)]
pub struct Status {
    phase: &'static str,
    offset: u64,
    digest: String,
}

impl Checkpoint {
    fn new(name: String, size: u64) -> Self {
        Self {
            name,
            size,
            offset: 0,
            digest: EMPTY_DIGEST.into(),
            destination: None,
            cancelled: false,
        }
    }

    fn load(dir: &Path) -> io::Result<Option<Self>> {
        match fs::read(dir.join("checkpoint.json")) {
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn save(&self, dir: &Path) -> io::Result<()> {
        fs::create_dir_all(dir)?;
        let temp = dir.join("checkpoint.tmp");
        let mut file = fs::File::create(&temp)?;
        serde_json::to_writer(&mut file, self)?;
        file.sync_all()?;
        drop(file);
        fs::rename(temp, dir.join("checkpoint.json"))
    }

    fn completed(&self, dir: &Path) -> bool {
        self.destination.is_some() && !dir.join("data.part").exists()
    }

    fn status(&self, dir: &Path) -> Status {
        Status {
            phase: if self.cancelled {
                "cancelled"
            } else if self.completed(dir) {
                "completed"
            } else {
                "paused"
            },
            offset: self.offset,
            digest: self.digest.clone(),
        }
    }

    fn progress(&self, id: &str, phase: Phase, speed: f64) -> Progress {
        Progress {
            transfer_id: id.into(),
            name: self.name.clone(),
            size: self.size,
            received: self.offset,
            speed,
            phase,
            error: None,
        }
    }

    // The destination is journaled before the rename. A repeat request after
    // loss of the final reply can therefore acknowledge the already saved file.
    fn publish(&mut self, dir: &Path, inbox: &Path) -> io::Result<PathBuf> {
        let _publish = crate::receive::DESTINATION_LOCK.lock().unwrap();
        let destination = crate::available_file_path(inbox, &self.name);
        self.destination = Some(destination.file_name().unwrap().to_string_lossy().into());
        self.save(dir)?;
        fs::rename(dir.join("data.part"), &destination)?;
        Ok(destination)
    }
}

#[derive(Default)]
pub struct Store {
    active: Mutex<HashMap<String, Arc<Control>>>,
    awaiting: Mutex<HashMap<String, Instant>>,
}

struct Lease<'a> {
    store: &'a Store,
    id: &'a str,
    control: Arc<Control>,
}

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        self.store.active.lock().unwrap().remove(self.id);
    }
}

pub struct Chunk<'a> {
    pub id: &'a str,
    pub name: String,
    pub size: u64,
    pub offset: u64,
    pub length: u64,
    pub digest: &'a str,
    pub prefix: &'a [u8],
}

impl Store {
    pub fn prepare(&self, inbox: &Path) -> io::Result<String> {
        let active = self.active.lock().unwrap();
        let root = root(inbox);
        fs::create_dir_all(&root)?;
        Self::sweep(&root, &active)?;
        let file = root.join("receiver-id");
        if let Ok(id) = fs::read_to_string(&file) {
            if valid_id(&id) {
                return Ok(id);
            }
        }
        let id = crate::discovery::instance_id();
        fs::write(&file, &id)?;
        Ok(id)
    }

    fn sweep(root: &Path, active: &HashMap<String, Arc<Control>>) -> io::Result<usize> {
        let mut remaining = 0_usize;
        let mut terminal = Vec::new();
        for entry in fs::read_dir(root)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(id) = name.to_str().filter(|id| valid_id(id)) else {
                continue;
            };
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let modified = fs::metadata(entry.path().join("checkpoint.json"))
                .or_else(|_| entry.metadata())?
                .modified()?;
            if !active.contains_key(id) && modified.elapsed().is_ok_and(|age| age >= RETENTION) {
                fs::remove_dir_all(entry.path())?;
            } else {
                remaining += 1;
                if !active.contains_key(id)
                    && Checkpoint::load(&entry.path())?
                        .is_some_and(|record| record.cancelled || record.completed(&entry.path()))
                {
                    terminal.push((modified, entry.path()));
                }
            }
        }
        terminal.sort();
        for (_, path) in terminal
            .into_iter()
            .take(remaining.saturating_sub(MAX_RECORDS - 1))
        {
            fs::remove_dir_all(path)?;
            remaining -= 1;
        }
        Ok(remaining)
    }

    pub fn pending(&self, inbox: &Path) -> io::Result<Vec<Progress>> {
        let _state = self.active.lock().unwrap();
        let mut result = Vec::new();
        for entry in fs::read_dir(root(inbox))? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(id) = name.to_str().filter(|id| valid_id(id)) else {
                continue;
            };
            if !entry.file_type()?.is_dir() {
                continue;
            }
            if let Ok(Some(record)) = Checkpoint::load(&entry.path()) {
                if !record.cancelled && !record.completed(&entry.path()) {
                    result.push(record.progress(id, Phase::Paused, 0.0));
                }
            }
        }
        Ok(result)
    }

    pub fn pause_idle(&self, inbox: &Path, mut notify: impl FnMut(Progress)) {
        let active = self.active.lock().unwrap();
        self.awaiting.lock().unwrap().retain(|id, since| {
            if since.elapsed() < Duration::from_secs(12) || active.contains_key(id) {
                return true;
            }
            let dir = root(inbox).join(id);
            if let Ok(Some(record)) = Checkpoint::load(&dir) {
                if !record.cancelled && !record.completed(&dir) {
                    notify(record.progress(id, Phase::Paused, 0.0));
                }
            }
            false
        });
    }

    pub fn active_ids(&self) -> Vec<String> {
        let active = self.active.lock().unwrap();
        let awaiting = self.awaiting.lock().unwrap();
        active
            .keys()
            .chain(awaiting.keys().filter(|id| !active.contains_key(*id)))
            .cloned()
            .collect()
    }

    pub fn suspend(&self, stop: &AtomicBool) {
        let active = self.active.lock().unwrap();
        stop.store(true, Ordering::Relaxed);
        self.awaiting.lock().unwrap().clear();
        for control in active.values() {
            control.cancel();
        }
    }

    pub fn status(&self, inbox: &Path, id: &str) -> io::Result<Option<Status>> {
        let _state = self.active.lock().unwrap();
        let dir = root(inbox).join(id);
        Ok(Checkpoint::load(&dir)?.map(|record| record.status(&dir)))
    }

    pub fn cancel(
        &self,
        inbox: &Path,
        id: &str,
        mut notify: impl FnMut(Progress),
    ) -> io::Result<Status> {
        let active = self.active.lock().unwrap();
        let dir = root(inbox).join(id);
        let existing = Checkpoint::load(&dir)?;
        if existing.is_none() && Self::sweep(&root(inbox), &active)? >= MAX_RECORDS {
            return Err(io::Error::other("Too many saved transfers"));
        }
        let had_record = existing.is_some();
        let mut record = existing.unwrap_or_else(|| Checkpoint::new(String::new(), 0));
        if !record.completed(&dir) {
            self.awaiting.lock().unwrap().remove(id);
            record.cancelled = true;
            record.save(&dir)?;
            if let Some(control) = active.get(id) {
                control.cancel();
            }
            match fs::remove_file(dir.join("data.part")) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            if had_record {
                notify(record.progress(id, Phase::Cancelled, 0.0));
            }
        }
        Ok(record.status(&dir))
    }

    pub fn append(
        &self,
        inbox: &Path,
        chunk: Chunk<'_>,
        source: &mut impl Read,
        stop: &AtomicBool,
        mut notify: impl FnMut(Progress),
    ) -> io::Result<(Status, Option<PathBuf>)> {
        if chunk.offset > chunk.size
            || chunk.length != CHUNK.min(chunk.size - chunk.offset)
            || (chunk.offset != chunk.size && chunk.offset % CHUNK != 0)
            || chunk.digest.len() != 64
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid chunk range",
            ));
        }
        let dir = root(inbox).join(chunk.id);
        let (mut record, lease) = {
            let mut active = self.active.lock().unwrap();
            if stop.load(Ordering::Relaxed) {
                return Err(io::Error::other("Receiver is offline"));
            }
            let record = match Checkpoint::load(&dir)? {
                Some(record) => record,
                None => {
                    if chunk.offset != 0 {
                        return Err(io::Error::new(
                            io::ErrorKind::NotFound,
                            "Saved transfer is unavailable",
                        ));
                    }
                    if Self::sweep(&root(inbox), &active)? >= MAX_RECORDS {
                        return Err(io::Error::other("Too many saved transfers"));
                    }
                    let record = Checkpoint::new(chunk.name.clone(), chunk.size);
                    record.save(&dir)?;
                    record
                }
            };
            if record.cancelled {
                return Ok((record.status(&dir), None));
            }
            if record.name != chunk.name || record.size != chunk.size {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Transfer metadata does not match",
                ));
            }
            if record.completed(&dir) || active.contains_key(chunk.id) {
                return Ok((record.status(&dir), None));
            }
            if record.offset == record.size && dir.join("data.part").exists() {
                let mut record = record;
                let path = record.publish(&dir, inbox)?;
                notify(record.progress(chunk.id, Phase::Completed, 0.0));
                return Ok((record.status(&dir), Some(path)));
            }
            if record.offset != chunk.offset {
                return Ok((record.status(&dir), None));
            }
            if active.len() >= 16 {
                return Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "Receiver is busy",
                ));
            }
            let control = Arc::new(Control::new(chunk.id.into()));
            active.insert(chunk.id.into(), control.clone());
            self.awaiting.lock().unwrap().remove(chunk.id);
            notify(record.progress(chunk.id, Phase::Receiving, 0.0));
            (
                record,
                Lease {
                    store: self,
                    id: chunk.id,
                    control,
                },
            )
        };

        let started = Instant::now();
        let mut bytes = Vec::with_capacity(chunk.length as usize);
        let read = crate::receive::copy_body(
            &mut lease
                .control
                .reader_with_idle_timeout(source, Duration::from_secs(10)),
            &mut bytes,
            chunk.prefix,
            chunk.length,
            |_| {},
        );
        let _state = self.active.lock().unwrap();
        if let Some(current) = Checkpoint::load(&dir)?.filter(|current| current.cancelled) {
            return Ok((current.status(&dir), None));
        }
        let result = (|| {
            read?;
            lease.control.check()?;
            let digest = format!(
                "{:x}",
                Sha256::new()
                    .chain_update(record.digest.as_bytes())
                    .chain_update(&bytes)
                    .finalize()
            );
            if digest != chunk.digest {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Chunk checksum did not match",
                ));
            }
            let mut file = OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(dir.join("data.part"))?;
            if file.metadata()?.len() < record.offset {
                return Err(io::Error::other("Saved transfer data is incomplete"));
            }
            file.set_len(record.offset)?;
            file.seek(SeekFrom::Start(record.offset))?;
            file.write_all(&bytes)?;
            file.sync_data()?;
            drop(file);
            record.offset += chunk.length;
            record.digest = digest;
            record.save(&dir)?;
            let speed = chunk.length as f64 / started.elapsed().as_secs_f64().max(0.001);
            let path = if record.offset == record.size {
                Some(record.publish(&dir, inbox)?)
            } else {
                self.awaiting
                    .lock()
                    .unwrap()
                    .insert(chunk.id.into(), Instant::now());
                None
            };
            notify(record.progress(
                chunk.id,
                if path.is_some() {
                    Phase::Completed
                } else {
                    Phase::Receiving
                },
                speed,
            ));
            Ok((record.status(&dir), path))
        })();
        if result.is_err() {
            let saved = Checkpoint::load(&dir).ok().flatten();
            if let Some(saved) = saved {
                notify(saved.progress(chunk.id, Phase::Paused, 0.0));
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    struct Inbox(PathBuf);
    impl Inbox {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "pulsedrop-resume-{}",
                crate::discovery::instance_id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Inbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn digest(previous: &str, bytes: &[u8]) -> String {
        format!(
            "{:x}",
            Sha256::new()
                .chain_update(previous.as_bytes())
                .chain_update(bytes)
                .finalize()
        )
    }

    fn append(
        store: &Store,
        inbox: &Path,
        size: u64,
        offset: u64,
        expected: &str,
        body: &[u8],
    ) -> io::Result<(Status, Option<PathBuf>)> {
        store.append(
            inbox,
            Chunk {
                id: ID,
                name: "example.bin".into(),
                size,
                offset,
                length: CHUNK.min(size - offset),
                digest: expected,
                prefix: &[],
            },
            &mut Cursor::new(body),
            &AtomicBool::new(false),
            |_| {},
        )
    }

    #[test]
    fn resumes_after_restart_and_retries_are_idempotent() {
        let inbox = Inbox::new();
        let bytes = vec![13; CHUNK as usize];
        let tail = b"last bytes";
        let size = CHUNK + tail.len() as u64;
        let first = digest(EMPTY_DIGEST, &bytes);
        let final_digest = digest(&first, tail);
        let store = Store::default();
        let receiver = store.prepare(&inbox.0).unwrap();
        fs::write(inbox.0.join("example.bin"), b"already here").unwrap();

        let (ack, _) = append(&store, &inbox.0, size, 0, &first, &bytes).unwrap();
        assert_eq!(ack.offset, CHUNK);
        // A duplicate request after a lost acknowledgement does not append.
        let (ack, _) = append(&store, &inbox.0, size, 0, &first, &bytes).unwrap();
        assert_eq!(ack.offset, CHUNK);
        assert!(append(&store, &inbox.0, size, CHUNK, &final_digest, &tail[..2]).is_err());
        let part = root(&inbox.0).join(ID).join("data.part");
        assert_eq!(fs::metadata(&part).unwrap().len(), CHUNK);
        // Simulate process loss after writing bytes, before advancing the journal.
        OpenOptions::new()
            .append(true)
            .open(&part)
            .unwrap()
            .write_all(b"unconfirmed")
            .unwrap();
        drop(store);

        let store = Store::default();
        assert_eq!(store.prepare(&inbox.0).unwrap(), receiver);
        let pending = store.pending(&inbox.0).unwrap();
        assert_eq!(pending[0].phase, Phase::Paused);
        assert_eq!(pending[0].received, CHUNK);
        assert_eq!(store.status(&inbox.0, ID).unwrap().unwrap().digest, first);
        let (ack, saved) = append(&store, &inbox.0, size, CHUNK, &final_digest, tail).unwrap();
        assert_eq!(ack.phase, "completed");
        assert_eq!(ack.offset, size);
        let saved = saved.unwrap();
        assert_eq!(fs::read(&saved).unwrap(), [bytes.as_slice(), tail].concat());
        assert_eq!(
            fs::read(inbox.0.join("example.bin")).unwrap(),
            b"already here"
        );
        assert!(!part.exists());
        let store = Store::default();
        assert_eq!(
            store.status(&inbox.0, ID).unwrap().unwrap().phase,
            "completed"
        );
        assert!(append(&store, &inbox.0, size, CHUNK, &final_digest, tail)
            .unwrap()
            .1
            .is_none());
        assert_eq!(
            store.cancel(&inbox.0, ID, |_| {}).unwrap().phase,
            "completed"
        );
        assert!(saved.exists());
    }

    #[test]
    fn verifies_chunks_and_cancellation_discards_data_across_restart() {
        let inbox = Inbox::new();
        let store = Store::default();
        store.prepare(&inbox.0).unwrap();
        let size = CHUNK + 1;
        let bytes = vec![27; CHUNK as usize];
        assert!(append(&store, &inbox.0, size, 0, EMPTY_DIGEST, &bytes).is_err());
        assert_eq!(store.status(&inbox.0, ID).unwrap().unwrap().offset, 0);
        let first = digest(EMPTY_DIGEST, &bytes);
        append(&store, &inbox.0, size, 0, &first, &bytes).unwrap();
        assert_eq!(
            store
                .cancel(&inbox.0, ID, |event| assert_eq!(
                    event.phase,
                    Phase::Cancelled
                ))
                .unwrap()
                .phase,
            "cancelled"
        );
        assert!(!root(&inbox.0).join(ID).join("data.part").exists());
        let store = Store::default();
        let (ack, saved) =
            append(&store, &inbox.0, size, CHUNK, &digest(&first, b"x"), b"x").unwrap();
        assert_eq!(ack.phase, "cancelled");
        assert!(saved.is_none());
        assert!(!inbox.0.join("example.bin").exists());
    }

    #[test]
    fn publishes_a_fully_checkpointed_file_after_interrupted_finalization() {
        let inbox = Inbox::new();
        let store = Store::default();
        store.prepare(&inbox.0).unwrap();
        let dir = root(&inbox.0).join(ID);
        let mut record = Checkpoint::new("example.bin".into(), 3);
        record.offset = 3;
        record.digest = digest(EMPTY_DIGEST, b"abc");
        record.save(&dir).unwrap();
        fs::write(dir.join("data.part"), b"abc").unwrap();

        let (ack, saved) = append(&store, &inbox.0, 3, 3, &record.digest, b"").unwrap();
        assert_eq!(ack.phase, "completed");
        assert_eq!(fs::read(saved.unwrap()).unwrap(), b"abc");
    }
}
