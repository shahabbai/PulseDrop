fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS");
    println!("cargo:rerun-if-changed=native/wifi_macos.m");
    if target_os.as_deref() == Ok("macos") {
        cc::Build::new()
            .file("native/wifi_macos.m")
            .flag("-fobjc-arc")
            .compile("pulsedrop_wifi");
        for framework in ["Foundation", "CoreWLAN", "CoreLocation"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }

    if target_os.as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        // Tauri's compiled resource reaches the app binary but not the library
        // test harness. Let the linker embed Common Controls v6 in both.
        const COMMON_CONTROLS: &str = "type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'";
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:{COMMON_CONTROLS}");

        let attributes = tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        tauri_build::try_build(attributes).expect("failed to run Tauri build helpers");
    } else {
        tauri_build::build();
    }
}
