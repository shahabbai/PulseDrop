fn main() {
    // Select shared-memory buffers before GTK starts the WebKit process.
    // The hardware GBM path can abort in Mesa when the renderer exits.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DMABUF_RENDERER_FORCE_SHM").is_none() {
        std::env::set_var("WEBKIT_DMABUF_RENDERER_FORCE_SHM", "1");
    }

    pulse_drop_lib::run();
}
