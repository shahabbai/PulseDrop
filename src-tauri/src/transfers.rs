use crate::receive::Phase;
use std::{
    collections::HashMap,
    io,
    net::{Shutdown, TcpStream},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

struct State {
    phase: Phase,
    socket: Option<TcpStream>,
    finished: Option<Instant>,
}

pub(crate) struct Control {
    pub id: String,
    state: Mutex<State>,
}

impl Control {
    pub fn new(id: String, socket: Option<TcpStream>) -> Self {
        Self {
            id,
            state: Mutex::new(State {
                phase: Phase::Receiving,
                socket,
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

    pub fn cancel(&self) -> Phase {
        let mut state = self.state.lock().unwrap();
        if state.phase == Phase::Receiving {
            state.phase = Phase::Cancelled;
            state.finished = Some(Instant::now());
            if let Some(socket) = state.socket.take() {
                // Wake a blocked upload read, retaining the write half for its response.
                let _ = socket.shutdown(Shutdown::Read);
            }
        }
        state.phase.clone()
    }

    pub fn fail(&self) -> Phase {
        let mut state = self.state.lock().unwrap();
        if state.phase == Phase::Receiving {
            state.phase = Phase::Failed;
            state.finished = Some(Instant::now());
        }
        state.socket.take();
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
        state.socket.take();
        result
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
        let control = Arc::new(Control::new(
            id.clone(),
            Some(stream.try_clone().map_err(|error| error.to_string())?),
        ));
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
            .or_insert_with(|| Arc::new(Control::new(id.into(), None)))
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
        io::{Read, Write},
        net::TcpListener,
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
        let control = Control::new("blocked".into(), Some(server.try_clone().unwrap()));
        let mut reader = server.try_clone().unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            started_tx.send(()).unwrap();
            reader.read(&mut [0])
        });
        started_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(control.cancel(), Phase::Cancelled);
        let result = worker.join().unwrap();
        assert!(result.is_err() || result.unwrap() == 0);
        server.write_all(b"Cancelled").unwrap();
        let mut response = [0; 9];
        client.read_exact(&mut response).unwrap();
        assert_eq!(&response, b"Cancelled");
    }

    #[test]
    fn cancellation_and_commit_have_one_terminal_winner() {
        let control = Control::new("cancel-first".into(), None);
        control.cancel();
        assert!(control
            .commit(|| -> io::Result<()> { panic!("Cancelled upload must never commit") })
            .is_err());
        assert_eq!(control.fail(), Phase::Cancelled);
        let control = Arc::new(Control::new("commit-first".into(), None));
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
        // Use a separate socket: shutting down a cloned handle affects its peers.
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
