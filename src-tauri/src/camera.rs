//! Linux WebKit requires an explicit media permission response. Only the
//! receiver QR scanner's user-initiated, short-lived video request is allowed.
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

#[derive(Default)]
pub(crate) struct CameraAccess(Mutex<Option<Instant>>);

impl CameraAccess {
    pub fn request(&self, active: bool) {
        *self.0.lock().unwrap() = active.then(|| Instant::now() + Duration::from_secs(90));
    }

    #[cfg(any(target_os = "linux", test))]
    fn allows(&self, uri: &str, video: bool, audio: bool) -> bool {
        let origin = tauri::Url::parse(uri).ok().is_some_and(|url| {
            (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                || (matches!(url.scheme(), "http" | "https")
                    && url.host_str() == Some("tauri.localhost"))
        });
        origin
            && video
            && !audio
            && self
                .0
                .lock()
                .unwrap()
                .is_some_and(|until| Instant::now() < until)
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn configure(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Manager;
    use webkit2gtk::{
        glib::Cast, PermissionRequestExt, SettingsExt, UserMediaPermissionRequest,
        UserMediaPermissionRequestExt, WebViewExt,
    };
    let handle = app.handle().clone();
    if let Some(window) = app.get_webview_window("main") {
        window.with_webview(move |view| {
            if let Some(settings) = view.inner().settings() {
                settings.set_enable_media_stream(true);
            }
            view.inner()
                .connect_permission_request(move |webview, request| {
                    if let Some(media) = request.downcast_ref::<UserMediaPermissionRequest>() {
                        if handle.state::<CameraAccess>().allows(
                            webview.uri().as_deref().unwrap_or(""),
                            media.is_for_video_device(),
                            media.is_for_audio_device(),
                        ) {
                            request.allow();
                        } else {
                            request.deny();
                        }
                        return true;
                    }
                    false
                });
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn camera_requires_explicit_unexpired_video_request_from_app_origin() {
        let access = CameraAccess::default();
        assert!(!access.allows("tauri://localhost", true, false));
        access.request(true);
        assert!(access.allows("tauri://localhost/#send", true, false));
        assert!(access.allows("http://tauri.localhost/", true, false));
        for uri in [
            "https://example.com",
            "tauri://localhost.attacker",
            "http://localhost:3000",
            "file:///tmp/page.html",
        ] {
            assert!(!access.allows(uri, true, false));
        }
        assert!(!access.allows("tauri://localhost", true, true));
        assert!(!access.allows("tauri://localhost", false, false));
        access.request(false);
        assert!(!access.allows("tauri://localhost", true, false));
        *access.0.lock().unwrap() = Some(Instant::now() - Duration::from_secs(1));
        assert!(!access.allows("tauri://localhost", true, false));
    }
}
