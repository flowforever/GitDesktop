# GitDesktop Preview updates

The push build produces 14-day Actions artifacts for macOS (universal DMG),
Windows (NSIS) and Linux (AppImage). It does **not** publish releases. These
test builds have no update endpoint, no updater signatures and no startup
check. The stable application and its release workflow are unchanged.

## Set up signed distribution (not enabled)

1. In the fork, reserve a protected GitHub environment named `preview-release`
   for trusted `master` builds only. Generate a **new preview-only** Tauri
   keypair via `pnpm tauri signer generate --write-keys <protected-path>` on a
   trusted machine. Make an offline recovery copy. Store the private key and
   its password in that environment as `TAURI_SIGNING_PRIVATE_KEY` and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (the names consumed by Tauri). Put only
   the public key in a proposed `GITDESKTOP_PREVIEW_UPDATER_PUBKEY` environment
   variable. Do not reuse the upstream stable key or expose release secrets
   to PR or fork jobs.
2. Extend the protected packaging jobs to set
   `VITE_GITDESKTOP_PREVIEW_UPDATES=1`, embed the preview public key and feed URL
   in the Tauri updater config, keep `requireSignedVersion: true`, and
   enable `bundle.createUpdaterArtifacts`. Refuse to produce a signed preview
   with missing signing inputs. Keep the `com.thebguy.gitdesktop.preview`
   bundle identity and embedded per-run version on every platform. Tauri
   signs the updater payload and its version; the downloadable DMG is for
   initial macOS installation, not the in-app update payload.
3. For normal macOS distribution, replace the preview's ad hoc signing with
   Developer ID Application signing and Apple notarization. Use the protected
   environment's `APPLE_CERTIFICATE` (base64 .p12),
   `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
   `APPLE_PASSWORD` (app-specific password) and `APPLE_TEAM_ID`, as in the
   stable build. Verify the installed seed and its replacement use the same
   preview bundle ID and Developer Team. The updater signature is independent
   of Apple signing and Windows Authenticode; without Authenticode, Windows
   can still show an unrecognized publisher for a preview installer.
4. On approved publication, keep immutable, versioned updater payloads in
   GitHub prereleases (for example, tags `preview-<version>`, not `v*`).
   Point preview clients to one fixed HTTPS manifest, e.g.
   `https://github.com/flowforever/GitDesktop/releases/download/preview-channel/latest.json`
   from a separate rolling **prerelease**. Do not use
   `releases/latest/download/latest.json`; that is the stable channel.
   A trusted HTTPS static host for the same manifest is also suitable.
   GitHub Actions artifact URLs expire and are not an updater feed.
5. Give only the protected publisher job `contents: write` if using Releases.
   Publish the complete platform matrix before moving the manifest. Confirm
   its version equals the signed version and each target/architecture points
   to the intended immutable payload and signature. Serialize changes to the
   feed and refuse to move backwards on old build retries. A public feed and
   assets are readable by anyone; do not enable them without agreement on
   distribution. Do not embed a GitHub access token in the app. Publish
   privately only with a separately designed authenticated service.

## Gate before enabling

- Start with two signed **preview** builds, A and B, with increasing embedded
  versions. Install A manually while its feed offers A only; launch and
  confirm there is no prompt. Publish B to staging and relaunch A. Confirm the
  prompt shows B and does not start a download until the user accepts.
- Accept, install, restart if needed, and verify the running app reports B.
  Launch again and confirm it no longer offers B. Test each supported
  platform/architecture, including both macOS architectures for the universal
  bundle. Verify any earlier unsigned preview requires a new signed seed and
  that the stable application remains unaffected.
- Test same or older versions, missing entries, an unreachable feed, a wrong
  signature, tampered bytes, and a manifest version greater than the version
  embedded in a valid signature. Verify none install an update. Test declining
  the prompt and retry after download failure. Require gate success before the
  first production feed publication.

## CI without release secrets

The read-only `preview-updater-check` workflow runs focused UI/consent and
version tests, then `bash .github/scripts/check-preview-signature.sh`. The
script generates an ephemeral test key, uses the real Tauri signer to sign
small synthetic payloads, and deletes the key without uploading anything.
The offline Rust fixture uses the same minisign verification dependency and
signed-version field as the updater. It rejects same/older, wrong-key,
tampered, unversioned and mislabelled payloads. This proves the signed
payload/manifest contract, not the actual native install/restart path.
The PR-only `preview-updater-native` job is the separate Linux AppImage
acceptance test. It builds two actual signed packages, serves B via HTTPS on
`127.0.0.1`, then uses the official Tauri/WebKit WebDriver under Xvfb to launch
A, verify that the prompt downloads nothing until clicked, accept it,
checksum the installed AppImage against B, and verify B on relaunch. Linux
rustls uses a disposable CA via `SSL_CERT_FILE` only in the app subprocess;
host trust and TLS verification are not changed. The scripts do not publish
packages or retain keys. A passing run is required before treating Linux
native installation as verified; macOS and Windows need their own signed
acceptance runs.

See [Tauri updater](https://v2.tauri.app/plugin/updater/) and
[macOS signing](https://v2.tauri.app/distribute/sign/macos/).
