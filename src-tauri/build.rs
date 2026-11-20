fn main() {
    println!("cargo:rerun-if-env-changed=GITDESKTOP_FORK_STABLE");
    tauri_build::build()
}
