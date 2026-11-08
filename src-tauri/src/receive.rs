use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const PROGRESS_INTERVAL: Duration = Duration::from_millis(120);

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Phase {
    Receiving,
    Completed,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct Progress {
    pub transfer_id: String,
    pub name: String,
    pub size: u64,
    pub received: u64,
    pub speed: f64,
    pub phase: Phase,
    pub error: Option<String>,
}

pub(crate) struct SavedUpload {
    pub transfer_id: String,
    pub path: PathBuf,
}

// An empty, atomically reserved destination prevents simultaneous uploads with
// the same filename from replacing each other. Bytes stay in a separate folder
// until complete, out of reach of Android's finished-file mirror.
struct PendingUpload {
    destination: PathBuf,
    temporary: PathBuf,
    committed: bool,
}

impl PendingUpload {
    fn create(inbox: &Path, name: &str, id: &str) -> io::Result<(Self, File)> {
        let staging = inbox.join(".pulsedrop-transfers");
        fs::create_dir_all(&staging)?;
        let destination = loop {
            let path = super::available_file_path(inbox, name);
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(reservation) => {
                    drop(reservation);
                    break path;
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        };
        let temporary = staging.join(format!("{id}.part"));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => Ok((
                Self {
                    destination,
                    temporary,
                    committed: false,
                },
                file,
            )),
            Err(error) => {
                let _ = fs::remove_file(&destination);
                Err(error)
            }
        }
    }

    fn commit(mut self) -> io::Result<PathBuf> {
        fs::rename(&self.temporary, &self.destination)?;
        self.committed = true;
        Ok(self.destination.clone())
    }
}

impl Drop for PendingUpload {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_file(&self.temporary);
            let _ = fs::remove_file(&self.destination);
        }
    }
}

fn copy_body(
    source: &mut impl Read,
    destination: &mut impl Write,
    prefix: &[u8],
    size: u64,
    mut on_bytes: impl FnMut(u64),
) -> io::Result<()> {
    let initial = (prefix.len() as u64).min(size) as usize;
    let mut received = 0;
    if initial > 0 {
        destination.write_all(&prefix[..initial])?;
        received = initial as u64;
        on_bytes(received);
    }
    let mut buffer = [0_u8; 64 * 1024];
    while received < size {
        let count = (size - received).min(buffer.len() as u64) as usize;
        let read = match source.read(&mut buffer[..count]) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Upload ended early",
            ));
        }
        destination.write_all(&buffer[..read])?;
        received += read as u64;
        on_bytes(received);
    }
    destination.flush()
}

pub(crate) fn upload(
    source: &mut impl Read,
    inbox: &Path,
    name: &str,
    size: u64,
    prefix: &[u8],
    mut notify: impl FnMut(Progress),
) -> Result<SavedUpload, String> {
    let started = Instant::now();
    let mut last_update = started;
    let mut progress = Progress {
        transfer_id: super::discovery::instance_id(),
        name: name.to_string(),
        size,
        received: 0,
        speed: 0.0,
        phase: Phase::Receiving,
        error: None,
    };
    notify(progress.clone());
    let result = (|| -> io::Result<PathBuf> {
        let (pending, mut file) = PendingUpload::create(inbox, name, &progress.transfer_id)?;
        let copied = copy_body(source, &mut file, prefix, size, |received| {
            progress.received = received;
            let now = Instant::now();
            progress.speed = received as f64 / now.duration_since(started).as_secs_f64().max(0.001);
            if now.duration_since(last_update) >= PROGRESS_INTERVAL {
                notify(progress.clone());
                last_update = now;
            }
        });
        // Windows requires the handle to close before rename or error cleanup.
        drop(file);
        copied?;
        pending.commit()
    })();
    progress.speed = 0.0;
    match result {
        Ok(path) => {
            progress.phase = Phase::Completed;
            notify(progress.clone());
            Ok(SavedUpload {
                transfer_id: progress.transfer_id,
                path,
            })
        }
        Err(error) => {
            let message = format!("Could not receive {name}: {error}");
            progress.phase = Phase::Failed;
            progress.error = Some(message.clone());
            notify(progress);
            Err(message)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    struct TestInbox(PathBuf);
    impl TestInbox {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "pulsedrop-receive-{}",
                super::super::discovery::instance_id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestInbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn writes_header_prefix_and_stream_bytes_then_publishes_completion() {
        let inbox = TestInbox::new();
        let body = vec![7; 200_000];
        let mut events = Vec::new();
        let saved = upload(
            &mut Cursor::new(&body[4..]),
            &inbox.0,
            "test.bin",
            body.len() as u64,
            &body[..4],
            |event| {
                if event.phase == Phase::Completed {
                    assert_eq!(fs::read(inbox.0.join("test.bin")).unwrap(), body);
                }
                events.push(event);
            },
        )
        .unwrap();
        assert_eq!(fs::read(&saved.path).unwrap(), body);
        assert_eq!(events[0].phase, Phase::Receiving);
        assert_eq!(events[0].received, 0);
        assert_eq!(events.last().unwrap().phase, Phase::Completed);
        assert_eq!(events.last().unwrap().received, body.len() as u64);
        assert!(events
            .iter()
            .all(|event| event.transfer_id == saved.transfer_id));
        assert!(fs::read_dir(inbox.0.join(".pulsedrop-transfers"))
            .unwrap()
            .next()
            .is_none());
    }

    #[test]
    fn interrupted_upload_reports_failure_and_removes_incomplete_files() {
        let inbox = TestInbox::new();
        let mut events = Vec::new();
        assert!(upload(
            &mut Cursor::new(b"short"),
            &inbox.0,
            "test.bin",
            100,
            b"",
            |event| events.push(event)
        )
        .is_err());
        assert_eq!(events.last().unwrap().phase, Phase::Failed);
        assert_eq!(events.last().unwrap().received, 5);
        assert!(events
            .last()
            .unwrap()
            .error
            .as_ref()
            .unwrap()
            .contains("Upload ended early"));
        assert!(!events.iter().any(|event| event.phase == Phase::Completed));
        assert!(!inbox.0.join("test.bin").exists());
        assert!(fs::read_dir(inbox.0.join(".pulsedrop-transfers"))
            .unwrap()
            .next()
            .is_none());
    }

    #[test]
    fn empty_files_and_fully_buffered_bodies_complete_without_reading_more() {
        let inbox = TestInbox::new();
        for (name, size, prefix) in [
            ("empty", 0, b"".as_slice()),
            ("buffered", 3, b"abcEXTRA".as_slice()),
        ] {
            let mut events = Vec::new();
            let saved = upload(&mut io::empty(), &inbox.0, name, size, prefix, |event| {
                events.push(event)
            })
            .unwrap();
            assert_eq!(fs::metadata(saved.path).unwrap().len(), size);
            assert_eq!(events.last().unwrap().received, size);
            assert_eq!(events.last().unwrap().phase, Phase::Completed);
        }
    }

    #[test]
    fn reservations_preserve_existing_files_and_separate_same_named_uploads() {
        let inbox = TestInbox::new();
        fs::write(inbox.0.join("same.txt"), b"existing").unwrap();
        let (one, one_file) = PendingUpload::create(&inbox.0, "same.txt", "one").unwrap();
        let (two, two_file) = PendingUpload::create(&inbox.0, "same.txt", "two").unwrap();
        assert_ne!(one.destination, two.destination);
        assert_eq!(fs::metadata(&one.destination).unwrap().len(), 0);
        assert_eq!(fs::read(inbox.0.join("same.txt")).unwrap(), b"existing");
        drop(one_file);
        drop(two_file);
        let first_path = one.destination.clone();
        let second_path = two.destination.clone();
        drop(one);
        drop(two);
        assert!(!first_path.exists() && !second_path.exists());
    }

    #[test]
    fn copy_does_not_consume_bytes_after_content_length() {
        let mut source = Cursor::new(b"abcdefEXTRA");
        let mut target = Vec::new();
        let mut counts = Vec::new();
        copy_body(&mut source, &mut target, b"prefix", 9, |count| {
            counts.push(count)
        })
        .unwrap();
        assert_eq!(target, b"prefixabc");
        assert_eq!(source.position(), 3);
        assert_eq!(counts, [6, 9]);
    }

    #[test]
    fn slow_upload_emits_live_progress_and_stages_bytes_outside_the_finished_inbox() {
        struct SlowSource(u64);
        impl Read for SlowSource {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                if self.0 == 0 {
                    return Ok(0);
                }
                std::thread::sleep(Duration::from_millis(20));
                buffer[0] = 7;
                self.0 -= 1;
                Ok(1)
            }
        }
        let inbox = TestInbox::new();
        let mut events = Vec::new();
        upload(
            &mut SlowSource(18),
            &inbox.0,
            "slow.bin",
            18,
            b"",
            |event| {
                if event.phase == Phase::Receiving && event.received > 0 {
                    assert_eq!(fs::metadata(inbox.0.join("slow.bin")).unwrap().len(), 0);
                }
                events.push(event);
            },
        )
        .unwrap();
        assert!(events.iter().any(|event| event.phase == Phase::Receiving
            && event.received > 0
            && event.received < 18));
        assert!(
            events.len() < 10,
            "progress should be throttled, not emitted for every read"
        );
        assert_eq!(fs::read(inbox.0.join("slow.bin")).unwrap(), vec![7; 18]);
    }

    #[test]
    fn interrupted_reads_are_retried_and_short_reads_are_counted() {
        struct ShortSource {
            interrupted: bool,
            left: usize,
        }
        impl Read for ShortSource {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                if !self.interrupted {
                    self.interrupted = true;
                    return Err(io::Error::from(io::ErrorKind::Interrupted));
                }
                if self.left == 0 {
                    return Ok(0);
                }
                buffer[0] = 9;
                self.left -= 1;
                Ok(1)
            }
        }
        let mut bytes = Vec::new();
        let mut counts = Vec::new();
        copy_body(
            &mut ShortSource {
                interrupted: false,
                left: 3,
            },
            &mut bytes,
            b"",
            3,
            |count| counts.push(count),
        )
        .unwrap();
        assert_eq!(bytes, [9, 9, 9]);
        assert_eq!(counts, [1, 2, 3]);
    }
}
