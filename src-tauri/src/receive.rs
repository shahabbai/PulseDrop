use crate::transfers::Control;
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
    Cancelled,
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
    control: &Control,
    notify: impl FnMut(Progress),
) -> Result<SavedUpload, String> {
    upload_with_clock(
        source,
        inbox,
        name,
        size,
        prefix,
        control,
        notify,
        Instant::now,
    )
}

fn upload_with_clock(
    source: &mut impl Read,
    inbox: &Path,
    name: &str,
    size: u64,
    prefix: &[u8],
    control: &Control,
    mut notify: impl FnMut(Progress),
    mut clock: impl FnMut() -> Instant,
) -> Result<SavedUpload, String> {
    let started = clock();
    let mut last_update = started;
    let mut progress = Progress {
        transfer_id: control.id.clone(),
        name: name.to_string(),
        size,
        received: 0,
        speed: 0.0,
        phase: Phase::Receiving,
        error: None,
    };
    notify(progress.clone());
    let result = (|| -> io::Result<PathBuf> {
        control.check()?;
        let (pending, mut file) = PendingUpload::create(inbox, name, &progress.transfer_id)?;
        let copied = copy_body(
            &mut control.reader(source),
            &mut file,
            prefix,
            size,
            |received| {
                progress.received = received;
                let now = clock();
                progress.speed =
                    received as f64 / now.duration_since(started).as_secs_f64().max(0.001);
                if now.duration_since(last_update) >= PROGRESS_INTERVAL {
                    notify(progress.clone());
                    last_update = now;
                }
            },
        );
        // Windows requires the handle to close before rename or error cleanup.
        drop(file);
        copied?;
        control.commit(|| pending.commit())
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
            progress.phase = control.fail();
            let message = if progress.phase == Phase::Cancelled {
                "Transfer cancelled".into()
            } else {
                format!("Could not receive {name}: {error}")
            };
            progress.error = Some(message.clone());
            notify(progress);
            Err(message)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, io::Cursor};

    fn upload(
        source: &mut impl Read,
        inbox: &Path,
        name: &str,
        size: u64,
        prefix: &[u8],
        notify: impl FnMut(Progress),
    ) -> Result<SavedUpload, String> {
        super::upload(
            source,
            inbox,
            name,
            size,
            prefix,
            &Control::new(crate::discovery::instance_id()),
            notify,
        )
    }

    fn upload_with_clock(
        source: &mut impl Read,
        inbox: &Path,
        name: &str,
        size: u64,
        prefix: &[u8],
        notify: impl FnMut(Progress),
        clock: impl FnMut() -> Instant,
    ) -> Result<SavedUpload, String> {
        super::upload_with_clock(
            source,
            inbox,
            name,
            size,
            prefix,
            &Control::new(crate::discovery::instance_id()),
            notify,
            clock,
        )
    }

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
        struct TimedSource<'a> {
            delays: std::vec::IntoIter<u64>,
            elapsed: &'a Cell<Duration>,
        }
        impl Read for TimedSource<'_> {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                let Some(delay) = self.delays.next() else {
                    return Ok(0);
                };
                self.elapsed
                    .set(self.elapsed.get() + Duration::from_millis(delay));
                buffer[0] = 7;
                Ok(1)
            }
        }
        // Thread sleeps can overshoot on busy CI runners. Control elapsed time
        // rather than assuming a fixed number of events for 18 real reads.
        for (delays, expected_counts) in [
            (vec![20; 18], vec![0, 6, 12, 18]),
            // Every read may legitimately emit when reads take >= 120 ms.
            (vec![120; 18], (0..=18).collect()),
            // A long pause emits once; completion bypasses the throttle.
            (
                vec![
                    20, 20, 20, 20, 20, 20, 120, 20, 20, 20, 20, 20, 300, 20, 20, 20, 20, 20,
                ],
                vec![0, 6, 7, 13],
            ),
        ] {
            let inbox = TestInbox::new();
            let started = Instant::now();
            let elapsed = Cell::new(Duration::ZERO);
            let mut source = TimedSource {
                delays: delays.into_iter(),
                elapsed: &elapsed,
            };
            let mut events = Vec::new();
            let mut emitted_at = Vec::new();
            upload_with_clock(
                &mut source,
                &inbox.0,
                "slow.bin",
                18,
                b"",
                |event| {
                    if event.phase == Phase::Receiving && event.received > 0 {
                        assert_eq!(fs::metadata(inbox.0.join("slow.bin")).unwrap().len(), 0);
                        let staged = inbox
                            .0
                            .join(".pulsedrop-transfers")
                            .join(format!("{}.part", event.transfer_id));
                        assert_eq!(fs::metadata(staged).unwrap().len(), event.received);
                        assert!(event.speed > 0.0);
                    }
                    if event.phase == Phase::Receiving {
                        emitted_at.push(elapsed.get());
                    }
                    events.push(event);
                },
                || started + elapsed.get(),
            )
            .unwrap();
            let received_counts: Vec<_> = events
                .iter()
                .filter(|event| event.phase == Phase::Receiving)
                .map(|event| event.received)
                .collect();
            assert_eq!(received_counts, expected_counts);
            assert!(emitted_at
                .windows(2)
                .all(|pair| pair[1] - pair[0] >= PROGRESS_INTERVAL));
            assert_eq!(events.last().unwrap().phase, Phase::Completed);
            assert_eq!(events.last().unwrap().received, 18);
            assert_eq!(fs::read(inbox.0.join("slow.bin")).unwrap(), vec![7; 18]);
        }
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

    #[test]
    fn cancelled_upload_removes_staging_and_reservation_without_completion() {
        struct CancelSource<'a> {
            reads: usize,
            control: &'a Control,
        }
        impl Read for CancelSource<'_> {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                self.reads += 1;
                if self.reads == 2 {
                    self.control.cancel();
                }
                buffer[0] = 7;
                Ok(1)
            }
        }
        let inbox = TestInbox::new();
        let control = Control::new("cancel-body".into());
        let mut events = Vec::new();
        assert!(super::upload(
            &mut CancelSource {
                reads: 0,
                control: &control
            },
            &inbox.0,
            "test.bin",
            10,
            b"head",
            &control,
            |event| events.push(event)
        )
        .is_err());
        assert_eq!(events.last().unwrap().phase, Phase::Cancelled);
        assert_eq!(events.last().unwrap().received, 5);
        assert!(!events.iter().any(|event| event.phase == Phase::Completed));
        assert!(!inbox.0.join("test.bin").exists());
        assert_eq!(
            fs::read_dir(inbox.0.join(".pulsedrop-transfers"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn cancellation_before_start_and_after_last_byte_never_publishes_a_file() {
        for before_start in [true, false] {
            let inbox = TestInbox::new();
            let control = Control::new("cancel-boundary".into());
            if before_start {
                control.cancel();
            }
            let start = Instant::now();
            let mut tick = 0;
            let mut phases = Vec::new();
            let result = super::upload_with_clock(
                &mut io::empty(),
                &inbox.0,
                "test.bin",
                3,
                b"abc",
                &control,
                |event| {
                    if event.phase == Phase::Receiving && event.received == 3 {
                        control.cancel();
                    }
                    phases.push(event.phase);
                },
                || {
                    tick += 1;
                    start + Duration::from_millis(tick * 120)
                },
            );
            assert!(result.is_err());
            assert_eq!(phases.last(), Some(&Phase::Cancelled));
            assert!(!inbox.0.join("test.bin").exists());
        }
    }
}
