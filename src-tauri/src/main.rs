fn main() {
    #[cfg(target_os = "linux")]
    {
        // WebKitGTK reads these before starting its renderer. Shared memory
        // avoids Mesa GBM teardown, and CPU painting avoids Skia GPU workers
        // releasing EGL resources during NVIDIA driver shutdown.
        for option in [
            "WEBKIT_DMABUF_RENDERER_FORCE_SHM",
            "WEBKIT_SKIA_ENABLE_CPU_RENDERING",
        ] {
            if std::env::var_os(option).is_none() {
                std::env::set_var(option, "1");
            }
        }
    }

    pulse_drop_lib::run();
}
