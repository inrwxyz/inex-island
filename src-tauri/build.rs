fn main() {
    unsafe {
        std::env::set_var("PROTOC", protoc_bin_vendored::protoc_bin_path().unwrap());
    }
    let mut config = prost_build::Config::new();
    config.compile_protos(
        &[
            "proto/sharing_enums.proto",
            "proto/wire_format.proto",
            "proto/offline_wire_formats.proto",
            "proto/securemessage.proto",
            "proto/securegcm.proto",
            "proto/device_to_device_messages.proto",
            "proto/ukey.proto",
        ],
        &["proto/"],
    ).unwrap();

    // The UI (src/) is embedded into the exe at compile time.
    // Recursively register all frontend files so cargo never reuses a stale binary when UI changes.
    fn watch_dir(dir: &std::path::Path) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    watch_dir(&p);
                } else {
                    println!("cargo:rerun-if-changed={}", p.display());
                }
            }
        }
    }
    watch_dir(std::path::Path::new("../src"));
    watch_dir(std::path::Path::new("../main-parts"));
    println!("cargo:rerun-if-changed=tauri.conf.json");
    tauri_build::build()
}
