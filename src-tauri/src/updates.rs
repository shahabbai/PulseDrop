use serde::Serialize;
use std::{sync::Mutex, time::Duration};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::UpdaterExt;

#[derive(Clone, Default, Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum Status {
    #[default]
    Idle,
    Checking,
    Downloading {
        version: String,
        received: u64,
        total: Option<u64>,
    },
    Installing {
        version: String,
    },
    Current,
    Error {
        message: String,
    },
}

impl Status {
    fn busy(&self) -> bool {
        matches!(
            self,
            Self::Checking | Self::Downloading { .. } | Self::Installing { .. }
        )
    }
}

#[derive(Default)]
pub struct Updates(Mutex<Status>);

impl Updates {
    pub fn busy(&self) -> bool {
        self.0.lock().map_or(true, |status| status.busy())
    }

    fn set(&self, status: Status) {
        *self.0.lock().expect("update state lock") = status;
    }
}

#[tauri::command]
pub fn update_status(state: State<'_, Updates>) -> Status {
    state.0.lock().expect("update state lock").clone()
}

#[tauri::command]
pub fn start_update(app: AppHandle) -> Result<(), String> {
    if !supported_installation() {
        return Err(
            "Install PulseDrop from GitHub Releases to enable updates for this build.".into(),
        );
    }

    let receiver = app.state::<super::ReceiverState>();
    let runtime = receiver
        .runtime
        .lock()
        .map_err(|_| "Receiver state is unavailable.")?;
    if runtime.is_some() {
        return Err("Stop receiving before checking for updates.".into());
    }

    let state = app.state::<Updates>();
    let mut status = state.0.lock().map_err(|_| "Update state is unavailable.")?;
    if status.busy() {
        return Ok(());
    }
    *status = Status::Checking;
    drop(status);
    drop(runtime);

    tauri::async_runtime::spawn(async move {
        let result = check_and_install(&app).await;
        match result {
            Ok(false) => app.state::<Updates>().set(Status::Current),
            Ok(true) => {
                #[cfg(not(target_os = "windows"))]
                app.restart();
                // On Windows the NSIS updater exits the process and relaunches the updated app.
            }
            Err(message) => app.state::<Updates>().set(Status::Error { message }),
        }
    });
    Ok(())
}

fn supported_installation() -> bool {
    use tauri::utils::{config::BundleType, platform::bundle_type};
    match bundle_type() {
        Some(BundleType::Deb) => cfg!(all(target_os = "linux", target_arch = "x86_64")),
        Some(BundleType::Nsis) => cfg!(all(target_os = "windows", target_arch = "x86_64")),
        Some(BundleType::App) => {
            cfg!(target_os = "macos")
                && std::env::current_exe().ok().is_some_and(|exe| {
                    exe.ancestors().nth(3).is_some_and(|bundle| {
                        bundle
                            .extension()
                            .is_some_and(|extension| extension == "app")
                    })
                })
        }
        _ => false,
    }
}

#[tauri::command]
pub async fn available_update(app: AppHandle) -> Result<Option<String>, String> {
    if !supported_installation() {
        return Ok(None);
    }
    Ok(find_update(&app).await?.map(|update| update.version))
}

async fn find_update(app: &AppHandle) -> Result<Option<tauri_plugin_updater::Update>, String> {
    let updater = app
        .updater_builder()
        .timeout(Duration::from_secs(30))
        .configure_client(|client| client.https_only(true))
        .version_comparator(|current, release| {
            release.version.pre.is_empty() && release.version > current
        })
        .build()
        .map_err(|_| "PulseDrop could not initialize its updater.")?;
    let Some(update) = updater.check().await.map_err(|_| {
        "PulseDrop could not check GitHub for updates. Check your internet connection and try again."
    })? else {
        return Ok(None);
    };

    let url = &update.download_url;
    let release_path = format!(
        "/shahabbai/PulseDrop/releases/download/v{}/",
        update.version
    );
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !url.path().starts_with(&release_path)
    {
        return Err("The update download address is invalid.".into());
    }
    Ok(Some(update))
}

async fn check_and_install(app: &AppHandle) -> Result<bool, String> {
    let Some(mut update) = find_update(app).await? else {
        return Ok(false);
    };
    let version = update.version.clone();
    update.timeout = Some(Duration::from_secs(20 * 60));
    let state = app.state::<Updates>();
    state.set(Status::Downloading {
        version: version.clone(),
        received: 0,
        total: None,
    });
    let mut received = 0;
    let bytes = update.download(|length, total| {
        received += length as u64;
        state.set(Status::Downloading { version: version.clone(), received, total });
    }, || {}).await.map_err(|err| match err {
        tauri_plugin_updater::Error::Network(_) => {
            "The download was interrupted. Check your internet connection and try again."
        }
        _ => "PulseDrop could not download and verify the signed update. Try again or use GitHub Releases.",
    }.to_string())?;

    state.set(Status::Installing { version });
    tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|_| "The installer stopped unexpectedly.")?
        .map_err(|_| "The update could not be installed. Check the installer prompt or install it from GitHub Releases.")?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
        path::PathBuf,
        thread,
        time::{Duration, Instant},
    };
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tauri_plugin_updater::{Error, UpdaterExt};

    // Fixture signature from an independent test key over ARTIFACT and version 0.8.0.
    const ARTIFACT: &[u8] = b"PulseDrop OTA test artifact\n";
    const PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkgNjAzRDJCRDQzNTgwMEQ4OQpSV1NKRFlBMTFDczlZQVErem5qTU43eEYxcUxiSEFadjFwT29Od2lGWWRKTGNVOXR5aVc5YitXZwo=";
    const SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIG1pbmlzaWduIHNlY3JldCBrZXkKUlVTSkRZQTExQ3M5WUpsSUFDQkR6dmVUWUNwYTNIQTZia2d1VktzUGlZcUlnd3JpU2FLVzRYQzlYRHZsNWVMR0ZhVzV6SDR6RG1aejY1WkJIVU96ajF1ajdnaUVBN0lFRHdZPQp0cnVzdGVkIGNvbW1lbnQ6IHZlcnNpb246MC44LjAJZmlsZTpwdWxzZWRyb3AtdGVzdC5kZWIKb0xoZnVhMkxUK014NXF3alNEalBCclc3YTNFRUxiR2NJLzJPM0Jtd3BCS3A4U2dHN3ppT1Y1KzVvS09rK3BObHh2NlgyRzZlZWdYNGNaVm9NNDVoQ2c9PQo=";

    fn fetch_fixture(
        version: &str,
        payload: &'static [u8],
        expect_download: bool,
    ) -> Result<Option<Vec<u8>>, Error> {
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        server.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", server.local_addr().unwrap());
        let manifest = json!({
            "version": version,
            "platforms": { "test-asset": { "url": format!("{origin}/package"), "signature": SIGNATURE } },
            "android": { "sha256": "ignored by desktop" }
        }).to_string();
        let handle = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            for body in [manifest.as_bytes(), payload]
                .into_iter()
                .take(if expect_download { 2 } else { 1 })
            {
                let mut connection = loop {
                    match server.accept() {
                        Ok((connection, _)) => break connection,
                        Err(err)
                            if err.kind() == std::io::ErrorKind::WouldBlock
                                && Instant::now() < deadline =>
                        {
                            thread::sleep(Duration::from_millis(5))
                        }
                        Err(err) => panic!("fixture server did not receive a request: {err}"),
                    }
                };
                connection
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                for line in BufReader::new(&connection).lines() {
                    if line.unwrap().is_empty() {
                        break;
                    }
                }
                write!(
                    connection,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                connection.write_all(body).unwrap();
            }
        });

        let mut context = mock_context(noop_assets());
        context.package_info_mut().version = "0.7.0".parse().unwrap();
        context.config_mut().plugins.0.insert(
            "updater".into(),
            json!({
                "endpoints": [format!("{origin}/latest.json")],
                "pubkey": PUBLIC_KEY,
                "dangerousInsecureTransportProtocol": true,
                "requireSignedVersion": true
            }),
        );
        let app = mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        let updater = app
            .updater_builder()
            .target("test-asset")
            .executable_path(PathBuf::from(
                "/opt/PulseDrop.app/Contents/MacOS/pulse_drop",
            ))
            .timeout(Duration::from_secs(4))
            .no_proxy()
            .build()
            .unwrap();
        let result = tauri::async_runtime::block_on(async {
            let Some(mut update) = updater.check().await? else {
                return Ok(None);
            };
            update.timeout = Some(Duration::from_secs(4));
            update.download(|_, _| {}, || {}).await.map(Some)
        });
        handle.join().unwrap();
        result
    }

    #[test]
    fn downloads_only_a_newer_signed_version() {
        assert_eq!(
            fetch_fixture("0.8.0", ARTIFACT, true).unwrap().as_deref(),
            Some(ARTIFACT)
        );
        assert_eq!(fetch_fixture("0.7.0", ARTIFACT, false).unwrap(), None);
        assert_eq!(fetch_fixture("0.6.1", ARTIFACT, false).unwrap(), None);
        assert!(fetch_fixture("0.8.0", b"modified artifact", true).is_err());
        assert!(matches!(
            fetch_fixture("0.9.0", ARTIFACT, true),
            Err(Error::SignedVersionMismatch { .. })
        ));
    }
}
