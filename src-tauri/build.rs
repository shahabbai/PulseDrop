fn main() {
    println!("cargo:rerun-if-changed=native/wifi_macos.m");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("native/wifi_macos.m")
            .flag("-fobjc-arc")
            .compile("pulsedrop_wifi");
        for framework in ["Foundation", "CoreWLAN", "CoreLocation"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
    tauri_build::build();
}
