// The macOS Preview distribution mirrors MDE's consent-and-open flow, but
// never opens a disk image until the Tauri updater verifies its signature
// and signed version. The actual installation is left to Finder and the user.

#[tauri::command]
pub async fn preview_open_signed_dmg(
    app: tauri::AppHandle,
    expected_version: String,
) -> Result<(), String> {
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
        io::Write,
        process::Command,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    use tauri::Url;
    use tauri_plugin_opener::OpenerExt;
    use tauri_plugin_updater::UpdaterExt;

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

    pub(super) async fn download_and_open(app: tauri::AppHandle, version: &str) -> Result<(), String> {
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
        let update = app
            .updater_builder()
            .timeout(Duration::from_secs(120))
            // GitHub redirects release assets to its CDN. Require HTTPS
            // across redirects as well as for the original URL.
            .configure_client(|client| client.https_only(true))
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
        app.opener()
            .open_path(path.to_string_lossy().into_owned(), None::<&str>)
            .map_err(|e| e.to_string())?;
        // Launch Services and Finder use the file after the command returns.
        // Keep it in the OS temporary directory for this user to finish.
        disk_image.keep().map_err(|e| e.error.to_string())?;
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

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
