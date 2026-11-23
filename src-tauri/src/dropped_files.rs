use serde::Serialize;
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::UNIX_EPOCH,
};
use tauri::{Emitter, Manager, State, Window};

#[derive(Default)]
pub struct DroppedFiles {
    next_id: AtomicU64,
    files: Mutex<HashMap<u64, Arc<DroppedFile>>>,
}

struct DroppedFile {
    file: Mutex<File>,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileInfo {
    id: u64,
    name: String,
    size: u64,
    last_modified: u64,
}

#[derive(Serialize)]
struct DropBatch {
    files: Vec<FileInfo>,
    skipped: usize,
}

impl DroppedFiles {
    // This is called only for paths supplied by the native window drop event.
    fn register(&self, path: &Path) -> Option<FileInfo> {
        if !path.is_absolute() || !path.metadata().ok()?.is_file() {
            return None;
        }
        let name = path.file_name()?.to_string_lossy().into_owned();
        let file = File::open(path).ok()?;
        let metadata = file.metadata().ok()?;
        if !metadata.is_file() {
            return None;
        }
        let size = metadata.len();
        let last_modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |elapsed| elapsed.as_millis() as u64);
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.files.lock().ok()?.insert(
            id,
            Arc::new(DroppedFile {
                file: Mutex::new(file),
                size,
            }),
        );
        Some(FileInfo {
            id,
            name,
            size,
            last_modified,
        })
    }

    fn read(&self, id: u64, offset: u64, length: u64) -> Result<Vec<u8>, String> {
        let entry = self
            .files
            .lock()
            .map_err(|_| "File queue is unavailable")?
            .get(&id)
            .cloned()
            .ok_or("Dropped file is no longer in the queue")?;
        if length > crate::resume::CHUNK || offset > entry.size || length > entry.size - offset {
            return Err("Invalid dropped file range".into());
        }
        let mut file = entry
            .file
            .lock()
            .map_err(|_| "Dropped file is unavailable")?;
        let mut bytes = vec![0; length as usize];
        file.seek(SeekFrom::Start(offset))
            .and_then(|_| file.read_exact(&mut bytes))
            .map_err(|error| format!("Could not read dropped file: {error}"))?;
        Ok(bytes)
    }

    fn release(&self, id: u64) {
        if let Ok(mut files) = self.files.lock() {
            files.remove(&id);
        }
    }
}

pub fn queue_window_drop(window: &Window, paths: Vec<PathBuf>) {
    let window = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = window.state::<DroppedFiles>();
        let mut batch = DropBatch {
            files: Vec::new(),
            skipped: 0,
        };
        for path in paths {
            if let Some(file) = state.register(&path) {
                batch.files.push(file);
            } else {
                batch.skipped += 1;
            }
        }
        if window
            .emit_to(window.label(), "pulsedrop-file-drop", &batch)
            .is_err()
        {
            for file in batch.files {
                state.release(file.id);
            }
        }
    });
}

#[tauri::command]
pub async fn read_dropped_file(
    window: Window,
    id: u64,
    offset: u64,
    length: u64,
) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        window
            .state::<DroppedFiles>()
            .read(id, offset, length)
            .map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|error| format!("Could not read dropped file: {error}"))?
}

#[tauri::command]
pub fn release_dropped_file(state: State<'_, DroppedFiles>, id: u64) {
    state.release(id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dropped_file_reads_are_bounded_to_registered_regular_files() {
        let folder = std::env::temp_dir().join(format!(
            "pulsedrop-drop-{}",
            crate::discovery::instance_id()
        ));
        std::fs::create_dir(&folder).unwrap();
        let path = folder.join("file with spaces.txt");
        std::fs::write(&path, b"some file contents").unwrap();
        let files = DroppedFiles::default();
        assert!(files.register(&folder).is_none());
        assert!(files.register(Path::new("file with spaces.txt")).is_none());
        assert!(files.read(0, 0, 1).is_err());
        let file = files.register(&path).unwrap();
        assert_eq!(file.name, "file with spaces.txt");
        assert_eq!(files.read(file.id, 5, 4).unwrap(), b"file");
        assert_eq!(files.read(file.id, file.size, 0).unwrap(), b"");
        assert!(files.read(file.id, file.size, 1).is_err());
        assert!(files.read(file.id, 0, crate::resume::CHUNK + 1).is_err());
        files.release(file.id);
        assert!(files.read(file.id, 0, 1).is_err());
        std::fs::remove_dir_all(folder).unwrap();
    }
}
