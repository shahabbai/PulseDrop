#[cfg(target_os = "linux")]
fn prefer_mesa_egl() {
    const VENDOR_FILES: &str = "__EGL_VENDOR_LIBRARY_FILENAMES";
    const VENDOR_DIRS: &str = "__EGL_VENDOR_LIBRARY_DIRS";
    const CONFIG_DIRS: [&str; 2] = ["/etc/glvnd/egl_vendor.d", "/usr/share/glvnd/egl_vendor.d"];

    if std::env::var_os(VENDOR_FILES).is_some() || std::env::var_os(VENDOR_DIRS).is_some() {
        return;
    }
    if !CONFIG_DIRS
        .iter()
        .any(|dir| std::path::Path::new(dir).join("10_nvidia.json").is_file())
    {
        return;
    }

    // WebKit can still create an EGL context with software Skia painting.
    // Its destruction can crash NVIDIA's driver. Select Mesa before GTK starts
    // so WebKit can retain WebGL without loading the NVIDIA EGL implementation.
    if let Some(mesa) = CONFIG_DIRS
        .iter()
        .map(|dir| std::path::Path::new(dir).join("50_mesa.json"))
        .find(|path| path.is_file())
    {
        std::env::set_var(VENDOR_FILES, mesa);
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    {
        prefer_mesa_egl();

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
