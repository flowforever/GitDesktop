// The macOS Preview distribution mirrors MDE's consent-and-open flow, but
// never opens a disk image until the Tauri updater verifies its signature
// and signed version. After opening it, the app requests its normal guarded
// quit so the user can replace the preview in Finder.

#[tauri::command]
pub async fn preview_open_signed_dmg(
    app: tauri::AppHandle,
    expected_version: String,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        macos::download_and_open(app, &expected_version).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, expected_version);
        Err("Opening a preview disk image is only available on macOS.".into())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::{
        future::Future,
        io::Write,
        process::Command,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    use tauri::{AppHandle, Runtime, Url};
    use tauri_plugin_updater::{UpdaterBuilder, UpdaterExt};

    const PRODUCTION: &str = "com.thebguy.gitdesktop.preview";
    const STAGING: &str = "com.thebguy.gitdesktop.preview.staging";
    const FILE: &str = "GitDesktop-Preview-macos-universal.dmg";

    fn expected_asset(identifier: &str, configured_endpoint: &str, asset: &Url, version: &str) -> bool {
        if asset.scheme() != "https"
            || !asset.username().is_empty()
            || asset.password().is_some()
            || asset.query().is_some()
            || asset.fragment().is_some()
        {
            return false;
        }
        if identifier == PRODUCTION {
            return asset.as_str() == format!(
                "https://github.com/flowforever/GitDesktop/releases/download/preview-{version}/{FILE}"
            );
        }
        identifier == STAGING
            && Url::parse(configured_endpoint)
                .is_ok_and(|endpoint| endpoint.scheme() == "https" && endpoint.origin() == asset.origin())
            && asset.path_segments().and_then(|mut segments| segments.next_back()) == Some(FILE)
    }

    pub(super) async fn download_and_open(
        app: tauri::AppHandle,
        version: &str,
    ) -> Result<bool, String> {
        let builder = app
            .updater_builder()
            .timeout(Duration::from_secs(120))
            // GitHub redirects release assets to its CDN. Require HTTPS
            // across redirects as well as for the original URL.
            .configure_client(|client| client.https_only(true));
        let disk_image = prepare_disk_image(&app, builder, version).await?;
        quit_after_open(
            async move {
                // The opener plugin detaches after spawning open, not after its
                // exit status. Wait for Launch Services to accept the DMG before
                // allowing GitDesktop to quit.
                let status = tokio::process::Command::new("/usr/bin/open")
                    .arg(disk_image.path())
                    .status()
                    .await
                    .map_err(|e| e.to_string())?;
                if !status.success() {
                    return Err("macOS could not open the preview disk image.".into());
                }
                // Finder needs the file after this process exits.
                disk_image.keep().map_err(|e| e.error.to_string())?;
                Ok(())
            },
            || request_guarded_quit(&app),
        )
        .await
    }

    async fn quit_after_open<F: Future<Output = bool>>(
        open: impl Future<Output = Result<(), String>>,
        request_quit: impl FnOnce() -> F,
    ) -> Result<bool, String> {
        open.await?;
        Ok(request_quit().await)
    }

    async fn request_guarded_quit(app: &tauri::AppHandle) -> bool {
        let (send, receive) = tokio::sync::oneshot::channel();
        let handle = app.clone();
        if app
            .run_on_main_thread(move || {
                let _ = send.send(crate::tray::request_quit(&handle));
            })
            .is_err()
        {
            return false;
        }
        receive.await.unwrap_or(false)
    }

    async fn prepare_disk_image<R: Runtime>(
        app: &AppHandle<R>,
        builder: UpdaterBuilder,
        version: &str,
    ) -> Result<tempfile::NamedTempFile, String> {
        let config = app.config();
        if config.identifier != PRODUCTION && config.identifier != STAGING {
            return Err("Only GitDesktop Preview can open this update.".into());
        }
        let updater = config
            .plugins
            .0
            .get("updater")
            .ok_or("Preview updater is not configured.")?;
        if updater["requireSignedVersion"].as_bool() != Some(true) {
            return Err("Preview updates require a version-bound signature.".into());
        }
        let endpoint = updater["endpoints"]
            .get(0)
            .and_then(|value| value.as_str())
            .ok_or("Preview update endpoint is missing.")?;
        let update = builder
            .build()
            .map_err(|e| e.to_string())?
            .check()
            .await
            .map_err(|e| e.to_string())?
            .ok_or("That preview update is no longer available.")?;
        if update.version != version
            || !expected_asset(&config.identifier, endpoint, &update.download_url, version)
        {
            return Err("The preview version or disk image no longer matches the update shown.".into());
        }
        let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
        let mut disk_image = tempfile::Builder::new()
            .prefix("GitDesktop-Preview-")
            .suffix(".dmg")
            .tempfile()
            .map_err(|e| e.to_string())?;
        disk_image.write_all(&bytes).map_err(|e| e.to_string())?;
        disk_image.as_file().sync_all().map_err(|e| e.to_string())?;
        let path = disk_image.path();
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_secs();
        // reqwest does not set a browser's quarantine metadata. Preserve
        // normal Gatekeeper checks instead of silently bypassing them.
        let quarantine = format!("0081;{timestamp:x};GitDesktop Preview;");
        let status = Command::new("/usr/bin/xattr")
            .args(["-w", "com.apple.quarantine", &quarantine])
            .arg(path)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("Could not mark the downloaded disk image for normal macOS checks.".into());
        }
        Ok(disk_image)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[tokio::test]
        async fn opens_before_requesting_guarded_quit() {
            let opened = std::cell::Cell::new(false);
            for quitting in [true, false] {
                opened.set(false);
                let result = quit_after_open(
                    async {
                        opened.set(true);
                        Ok(())
                    },
                    || async {
                        assert!(opened.get(), "launch the disk image before quitting");
                        quitting
                    },
                )
                .await;
                assert_eq!(result, Ok(quitting));
            }
        }

        #[tokio::test]
        async fn failed_disk_image_open_does_not_request_quit() {
            let result = quit_after_open(
                async { Err("Launch Services error".into()) },
                || async { panic!("failed disk image open must not quit") },
            )
            .await;
            assert_eq!(result, Err("Launch Services error".into()));
        }

        #[tokio::test]
        #[ignore = "requires disposable signed DMG, key and local HTTPS fixture from Actions"]
        async fn downloads_and_quarantines_signed_dmg() {
            let env = |name| std::env::var(name).expect(name);
            let feed = env("GD_DMG_TEST_FEED");
            let expected = std::fs::read(env("GD_DMG_TEST_PAYLOAD")).unwrap();
            let cert = reqwest::Certificate::from_pem(
                &std::fs::read(env("GD_DMG_TEST_CERT")).unwrap(),
            ).unwrap();
            let mut context = tauri::test::mock_context(tauri::test::noop_assets());
            context.config_mut().identifier = STAGING.into();
            context.config_mut().version = Some("2.0.0".into());
            context.package_info_mut().version = "2.0.0".parse().unwrap();
            context.config_mut().plugins.0.insert(
                "updater".to_string(),
                serde_json::json!({
                    "endpoints": [&feed],
                    "pubkey": env("GITDESKTOP_PREVIEW_UPDATER_PUBKEY"),
                    "requireSignedVersion": true,
                }),
            );
            let app = tauri::test::mock_builder()
                .plugin(tauri_plugin_updater::Builder::new().build())
                .build(context)
                .unwrap();
            let builder = || app.handle().updater_builder().timeout(Duration::from_secs(10));
            let local_builder = |client: UpdaterBuilder| {
                let root = cert.clone();
                client.configure_client(move |client| {
                    client.https_only(true).tls_certs_only([root.clone()])
                })
            };
            // Normal system trust must reject the disposable CA. Only the
            // test client adds it; this configuration is not shipped.
            let result = prepare_disk_image(app.handle(), builder(), "2.0.1").await;
            assert!(result.is_err());
            let mismatch = prepare_disk_image(app.handle(), local_builder(builder()), "2.0.2").await;
            assert!(mismatch.is_err());
            let mut tampered_url = Url::parse(&feed).unwrap();
            tampered_url.set_path("/tampered.json");
            let tampered_builder = local_builder(builder().endpoints(vec![tampered_url]).unwrap());
            assert!(prepare_disk_image(app.handle(), tampered_builder, "2.0.1").await.is_err());
            let completed = prepare_disk_image(app.handle(), local_builder(builder()), "2.0.1")
                .await
                .expect("native signed HTTPS DMG preparation");
            assert_eq!(std::fs::read(completed.path()).unwrap(), expected);
            let quarantine = Command::new("/usr/bin/xattr")
                .args(["-p", "com.apple.quarantine"])
                .arg(completed.path())
                .output()
                .unwrap();
            assert!(quarantine.status.success());
            assert!(String::from_utf8(quarantine.stdout).unwrap().contains("GitDesktop Preview"));
            assert!(Command::new("/usr/bin/hdiutil")
                .arg("verify")
                .arg(completed.path())
                .status()
                .unwrap()
                .success());
            let mount = tempfile::tempdir().unwrap();
            let attach = Command::new("/usr/bin/hdiutil")
                .args(["attach", "-readonly", "-nobrowse", "-mountpoint"])
                .arg(mount.path())
                .arg(completed.path())
                .status()
                .unwrap();
            assert!(attach.success(), "signed and quarantined fixture DMG should mount normally");
            let marker = std::fs::read_to_string(mount.path().join("README.txt"));
            let detach = Command::new("/usr/bin/hdiutil")
                .arg("detach")
                .arg(mount.path())
                .status()
                .unwrap();
            assert!(detach.success());
            assert!(marker.unwrap().contains("Synthetic preview fixture"));
        }

        #[test]
        fn production_requires_exact_versioned_repo_and_dmg() {
            let good = "https://github.com/flowforever/GitDesktop/releases/download/preview-1.2.3/GitDesktop-Preview-macos-universal.dmg";
            assert!(expected_asset(PRODUCTION, "", &Url::parse(good).unwrap(), "1.2.3"));
            for bad in [
                good.replace("https:", "http:"),
                good.replace("flowforever", "another-owner"),
                good.replace("1.2.3", "1.2.2"),
                good.replace(".dmg", ".app.tar.gz"),
                format!("{good}?redirect=1"),
            ] {
                assert!(!expected_asset(PRODUCTION, "", &Url::parse(&bad).unwrap(), "1.2.3"));
            }
        }

        #[test]
        fn staging_requires_its_own_https_origin_and_named_disk_image() {
            let endpoint = "https://test.example/latest.json";
            let other = Url::parse("https://elsewhere.example/GitDesktop-Preview-macos-universal.dmg").unwrap();
            let good = Url::parse("https://test.example/staging/GitDesktop-Preview-macos-universal.dmg").unwrap();
            assert!(expected_asset(STAGING, endpoint, &good, "1.2.3"));
            assert!(!expected_asset(STAGING, endpoint, &other, "1.2.3"));
        }
    }
}
