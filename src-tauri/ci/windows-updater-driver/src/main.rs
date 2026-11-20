// This CI-only executable is not linked into GitDesktop. A and B are actual
// GitDesktop/NSIS bundles built on a disposable Actions VM.

#[cfg(windows)]
use std::{path::PathBuf, time::Duration};
#[cfg(windows)]
use tauri_plugin_updater::UpdaterExt;

#[cfg(windows)]
const TEST_ID: &str = "com.thebguy.gitdesktop.preview.windowsci";

#[cfg(not(windows))]
fn main() {
    panic!("The isolated NSIS updater driver requires a hosted Windows runner");
}

#[cfg(windows)]
#[tokio::main(flavor = "current_thread")]
async fn main() {
    eprintln!("START: standalone native updater driver entered main");
    let path = |name| PathBuf::from(std::env::var_os(name).expect(name));
    let text = |name| std::env::var(name).expect(name);
    assert_eq!(text("GITHUB_ACTIONS"), "true");
    assert_eq!(text("RUNNER_ENVIRONMENT"), "github-hosted");
    let fixture = path("GD_WIN_FIXTURE_DIR").canonicalize().unwrap();
    let installed = path("GD_WIN_INSTALLED_EXE").canonicalize().unwrap();
    assert!(installed.starts_with(&fixture));
    let install_dir = path("GD_WIN_INSTALL_DIR").canonicalize().unwrap();
    assert_eq!(installed.parent(), Some(install_dir.as_path()));
    // Pass the original Win32 path to NSIS, not Rust's canonical verbatim path.
    let install_arg = format!("/D={}", path("GD_WIN_INSTALL_DIR").display());

    let feed = "https://127.0.0.1:18474/latest.json";
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = TEST_ID.into();
    context.config_mut().version = Some("1.0.1".into());
    context.package_info_mut().version = "1.0.1".parse().unwrap();
    context.config_mut().plugins.0.insert(
        "updater".into(),
        serde_json::json!({
            "endpoints": [feed],
            "pubkey": text("GD_WIN_TEST_PUBLIC_KEY"),
            "requireSignedVersion": true,
            "windows": { "installMode": "quiet" },
        }),
    );
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .unwrap();
    let builder = || {
        app.handle()
            .updater_builder()
            .timeout(Duration::from_secs(90))
            .executable_path(&installed)
    };
    assert!(builder().build().unwrap().check().await.is_err());
    let root = reqwest::Certificate::from_pem(&std::fs::read(path("GD_WIN_TEST_CA")).unwrap()).unwrap();
    eprintln!("PASS: default trust rejects the disposable CA");
    let update = builder()
        .configure_client(move |client| client.https_only(true).tls_certs_only([root.clone()]))
        .restart_after_install(false)
        .installer_arg(install_arg)
        .build()
        .unwrap()
        .check()
        .await
        .unwrap()
        .expect("signed NSIS update available");
    assert_eq!(update.current_version, "1.0.1");
    assert_eq!(update.version, "1.1.1");
    assert_eq!(update.download_url.as_str(), "https://127.0.0.1:18474/update.exe");
    eprintln!("PASS: scoped TLS trust checked the expected A to B manifest");
    let bytes = update.download(|_, _| {}, || {}).await.unwrap();
    assert!(bytes.starts_with(b"MZ"), "expected a real PE installer");
    std::fs::write(fixture.join("native-update-invoked"), "1.1.1").unwrap();
    eprintln!("PASS: Tauri verified the signed installer and embedded version");
    // Tauri checks the signature again, spawns the native installer and exits
    // this Rust driver process. PowerShell independently verifies the upgrade.
    update.install(&bytes).expect("start native NSIS installer");
    panic!("Windows updater unexpectedly returned without exiting");
}
