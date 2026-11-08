use crate::receive::Phase;
use std::{
    collections::HashMap,
    io::{self, Read},
    net::TcpStream,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const READ_POLL_INTERVAL: Duration = Duration::from_millis(200);
const UPLOAD_IDLE_TIMEOUT: Duration = Duration::from_secs(60);

struct State {
    phase: Phase,
    finished: Option<Instant>,
}

pub(crate) struct Control {
    pub id: String,
    state: Mutex<State>,
}

impl Control {
    pub fn new(id: String) -> Self {
        Self {
            id,
            state: Mutex::new(State {
                phase: Phase::Receiving,
                finished: None,
            }),
        }
    }

    pub fn phase(&self) -> Phase {
        self.state.lock().unwrap().phase.clone()
    }

    fn finished(&self) -> Option<Instant> {
        self.state.lock().unwrap().finished
    }

    pub fn check(&self) -> io::Result<()> {
        if self.phase() == Phase::Cancelled {
            Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "Transfer cancelled",
            ))
        } else {
            Ok(())
        }
    }

    pub fn reader<'a, R: Read>(&'a self, source: &'a mut R) -> CancellableReader<'a, R> {
        CancellableReader {
            source,
            control: self,
            last_byte: Instant::now(),
        }
    }

    pub fn cancel(&self) -> Phase {
        let mut state = self.state.lock().unwrap();
        if state.phase == Phase::Receiving {
            state.phase = Phase::Cancelled;
            state.finished = Some(Instant::now());
        }
        state.phase.clone()
    }

    pub fn fail(&self) -> Phase {
        let mut state = self.state.lock().unwrap();
        if state.phase == Phase::Receiving {
            state.phase = Phase::Failed;
            state.finished = Some(Instant::now());
        }
        state.phase.clone()
    }

    // Serialize cancellation against the final rename: a saved file remains
    // completed; an accepted cancellation can never publish a partial file.
    pub fn commit<T>(&self, commit: impl FnOnce() -> io::Result<T>) -> io::Result<T> {
        let mut state = self.state.lock().unwrap();
        if state.phase == Phase::Cancelled {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "Transfer cancelled",
            ));
        }
        let result = commit();
        state.phase = if result.is_ok() {
            Phase::Completed
        } else {
            Phase::Failed
        };
        state.finished = Some(Instant::now());
        result
    }
}

pub(crate) struct CancellableReader<'a, R> {
    source: &'a mut R,
    control: &'a Control,
    last_byte: Instant,
}

impl<R: Read> Read for CancellableReader<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        loop {
            self.control.check()?;
            let result = self.source.read(buffer);
            self.control.check()?;
            match result {
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    if self.last_byte.elapsed() >= UPLOAD_IDLE_TIMEOUT {
                        return Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            "Upload timed out waiting for data",
                        ));
                    }
                    // The socket's short timeout is a cancellation check, not
                    // an upload failure. Keep the original 60-second idle limit.
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Ok(count) => {
                    if count > 0 {
                        self.last_byte = Instant::now();
                    }
                    return Ok(count);
                }
                Err(error) => return Err(error),
            }
        }
    }
}

#[derive(Default)]
pub(crate) struct Transfers(Mutex<HashMap<String, Arc<Control>>>);

pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
}

impl Transfers {
    fn prune(entries: &mut HashMap<String, Arc<Control>>) {
        entries.retain(|_, control| {
            control.finished().map_or(true, |finished| {
                finished.elapsed() < Duration::from_secs(300)
            })
        });
        let mut terminal: Vec<_> = entries
            .values()
            .filter_map(|control| {
                control
                    .finished()
                    .map(|finished| (finished, control.id.clone()))
            })
            .collect();
        terminal.sort();
        let count = terminal.len().saturating_sub(256);
        for (_, id) in terminal.into_iter().take(count) {
            entries.remove(&id);
        }
    }

    pub fn register(&self, id: String, stream: &TcpStream) -> Result<Arc<Control>, String> {
        let mut entries = self.0.lock().unwrap();
        Self::prune(&mut entries);
        if let Some(existing) = entries.get(&id) {
            return Err(if existing.phase() == Phase::Cancelled {
                "Transfer cancelled"
            } else {
                "Transfer ID already used"
            }
            .into());
        }
        // Configure the actual reader before it starts. Socket shutdown through
        // a duplicated Windows handle must not be the cancellation mechanism.
        stream
            .set_read_timeout(Some(READ_POLL_INTERVAL))
            .map_err(|error| error.to_string())?;
        let control = Arc::new(Control::new(id.clone()));
        entries.insert(id, control.clone());
        Ok(control)
    }

    pub fn status(&self, id: &str) -> Option<Phase> {
        self.0
            .lock()
            .unwrap()
            .get(id)
            .map(|control| control.phase())
    }

    pub fn cancel(&self, id: &str) -> Phase {
        let mut entries = self.0.lock().unwrap();
        Self::prune(&mut entries);
        // A tombstone also covers cancel arriving before upload registration.
        entries
            .entry(id.into())
            .or_insert_with(|| Arc::new(Control::new(id.into())))
            .cancel()
    }

    pub fn cancel_all(&self) {
        for control in self.0.lock().unwrap().values() {
            control.cancel();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        net::{Shutdown, TcpListener},
        sync::mpsc,
        thread,
    };

    fn sockets() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (server, _) = listener.accept().unwrap();
        (client, server)
    }

    #[test]
    fn cancelling_wakes_a_blocked_read_and_retains_the_response_channel() {
        let (mut client, mut server) = sockets();
        client
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        server
            .set_write_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let registry = Transfers::default();
        let control = registry.register("blocked".into(), &server).unwrap();
        assert_eq!(server.read_timeout().unwrap(), Some(READ_POLL_INTERVAL));
        let mut reader = server.try_clone().unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        struct ReadyReader<'a> {
            stream: &'a mut TcpStream,
            ready: Option<mpsc::Sender<()>>,
        }
        impl Read for ReadyReader<'_> {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                if let Some(ready) = self.ready.take() {
                    ready.send(()).unwrap();
                }
                self.stream.read(buffer)
            }
        }
        let worker_control = control.clone();
        let worker = thread::spawn(move || {
            let mut source = ReadyReader {
                stream: &mut reader,
                ready: Some(started_tx),
            };
            let result = worker_control.reader(&mut source).read(&mut [0]);
            let _ = done_tx.send(result);
        });
        started_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(control.cancel(), Phase::Cancelled);
        let result = done_rx
            .recv_timeout(Duration::from_secs(10))
            .unwrap_or_else(|error| {
                // Release the peer and fail without an unbounded join on regression.
                let _ = client.shutdown(Shutdown::Both);
                panic!("Cancellation did not finish a stalled read: {error}");
            });
        worker.join().unwrap();
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::ConnectionAborted);
        server.write_all(b"Cancelled").unwrap();
        let mut response = [0; 9];
        client.read_exact(&mut response).unwrap();
        assert_eq!(&response, b"Cancelled");
    }

    #[test]
    fn reader_retries_both_platform_timeouts_and_resets_idle_deadline_on_data() {
        struct PausedReader(usize);
        impl Read for PausedReader {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                self.0 += 1;
                match self.0 {
                    1 => Err(io::ErrorKind::WouldBlock.into()),
                    2 => Err(io::ErrorKind::TimedOut.into()),
                    3 => Err(io::ErrorKind::Interrupted.into()),
                    _ => {
                        buffer[0] = 42;
                        Ok(1)
                    }
                }
            }
        }
        let control = Control::new("paused".into());
        let mut source = PausedReader(0);
        let mut reader = control.reader(&mut source);
        reader.last_byte = Instant::now() - Duration::from_secs(20);
        let resumed = Instant::now();
        let mut buffer = [0];
        assert_eq!(reader.read(&mut buffer).unwrap(), 1);
        assert_eq!(buffer, [42]);
        assert!(reader.last_byte >= resumed);
        assert_eq!(reader.source.0, 4);
        assert_eq!(control.phase(), Phase::Receiving);
    }

    #[test]
    fn reader_preserves_idle_timeout_and_non_retryable_errors() {
        struct ErrorReader(io::ErrorKind);
        impl Read for ErrorReader {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(self.0.into())
            }
        }
        let control = Control::new("idle".into());
        for kind in [io::ErrorKind::WouldBlock, io::ErrorKind::TimedOut] {
            let mut source = ErrorReader(kind);
            let mut reader = control.reader(&mut source);
            reader.last_byte = Instant::now() - UPLOAD_IDLE_TIMEOUT;
            let error = reader.read(&mut [0]).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::TimedOut);
            assert_eq!(error.to_string(), "Upload timed out waiting for data");
        }
        let mut source = ErrorReader(io::ErrorKind::ConnectionReset);
        assert_eq!(
            control
                .reader(&mut source)
                .read(&mut [0])
                .unwrap_err()
                .kind(),
            io::ErrorKind::ConnectionReset
        );
        assert_eq!(control.phase(), Phase::Receiving);
    }

    #[test]
    fn cancellation_during_a_timed_read_is_reported_as_cancelled() {
        struct CancelOnRead<'a>(&'a Control);
        impl Read for CancelOnRead<'_> {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                self.0.cancel();
                Err(io::ErrorKind::TimedOut.into())
            }
        }
        let control = Control::new("cancel-pause".into());
        let mut source = CancelOnRead(&control);
        assert_eq!(
            control
                .reader(&mut source)
                .read(&mut [0])
                .unwrap_err()
                .kind(),
            io::ErrorKind::ConnectionAborted
        );
        assert_eq!(control.phase(), Phase::Cancelled);
    }

    #[test]
    fn cancellation_and_commit_have_one_terminal_winner() {
        let control = Control::new("cancel-first".into());
        control.cancel();
        assert!(control
            .commit(|| -> io::Result<()> { panic!("Cancelled upload must never commit") })
            .is_err());
        assert_eq!(control.fail(), Phase::Cancelled);
        let control = Arc::new(Control::new("commit-first".into()));
        let (started_tx, started_rx) = mpsc::channel();
        let (finish_tx, finish_rx) = mpsc::channel();
        let worker_control = control.clone();
        let worker = thread::spawn(move || {
            worker_control.commit(|| {
                started_tx.send(()).unwrap();
                finish_rx.recv().unwrap();
                Ok(())
            })
        });
        started_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        let cancel_control = control.clone();
        let cancel = thread::spawn(move || cancel_control.cancel());
        finish_tx.send(()).unwrap();
        worker.join().unwrap().unwrap();
        assert_eq!(cancel.join().unwrap(), Phase::Completed);
        assert_eq!(control.cancel(), Phase::Completed);
    }

    #[test]
    fn registry_handles_early_cancellation_duplicate_ids_and_scoped_cancellation() {
        let (_client, server) = sockets();
        let registry = Transfers::default();
        assert_eq!(registry.cancel("early"), Phase::Cancelled);
        assert!(registry.register("early".into(), &server).is_err());
        let first = registry.register("first".into(), &server).unwrap();
        assert!(registry.register("first".into(), &server).is_err());
        // Each simulated upload has its own connection.
        let (_other_client, other_server) = sockets();
        let second = registry.register("second".into(), &other_server).unwrap();
        registry.cancel("first");
        assert_eq!(first.phase(), Phase::Cancelled);
        assert_eq!(second.phase(), Phase::Receiving);
        registry.cancel_all();
        assert_eq!(second.phase(), Phase::Cancelled);
    }

    #[test]
    fn terminal_history_is_bounded_and_expires_from_completion_not_upload_start() {
        let (_client, server) = sockets();
        let registry = Transfers::default();
        let active = registry.register("active".into(), &server).unwrap();
        for index in 0..300 {
            registry.cancel(&format!("cancel-{index}"));
        }
        assert!(registry.0.lock().unwrap().len() <= 258);
        assert_eq!(active.phase(), Phase::Receiving);
        let old = registry
            .0
            .lock()
            .unwrap()
            .get("cancel-299")
            .unwrap()
            .clone();
        old.state.lock().unwrap().finished = Some(Instant::now() - Duration::from_secs(301));
        registry.cancel("next");
        assert!(registry.status("cancel-299").is_none());
        assert_eq!(registry.status("active"), Some(Phase::Receiving));
    }

    #[test]
    fn transfer_ids_are_bounded_and_safe_as_staging_filenames() {
        for id in ["", "../file", "a/b", "a\\b", "a b", "💥"] {
            assert!(!valid_id(id));
        }
        assert!(!valid_id(&"x".repeat(129)));
        assert!(valid_id("550e8400-e29b-41d4-a716-446655440000"));
    }
}
