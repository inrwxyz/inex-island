fn main() {
    // The UI (src/) is embedded into the exe at compile time. Without these lines cargo can
    // reuse the old binary after only HTML/CSS/JS changed, and the app keeps showing the old UI.
    println!("cargo:rerun-if-changed=../src");
    println!("cargo:rerun-if-changed=../main-parts");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    tauri_build::build()
}
