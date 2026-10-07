fn main() {
    // The release workflow's run number, compiled in for the update check (src/updates.rs).
    println!("cargo:rerun-if-env-changed=ORBIT_BUILD");
    tauri_build::build()
}
