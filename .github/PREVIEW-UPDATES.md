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
2. The protected packaging jobs set
   `VITE_GITDESKTOP_PREVIEW_UPDATES=1`, embed the preview public key and feed URL
   in the Tauri updater config, keep `requireSignedVersion: true`, and
   enable `bundle.createUpdaterArtifacts`. Refuse to produce a signed preview
   with missing signing inputs. Keep the `com.thebguy.gitdesktop.preview`
   bundle identity and embedded per-run version on every platform. Tauri
   signs the updater payload and its version; the downloadable DMG is for
   initial macOS installation, not the in-app update payload.
3. The signed macOS leg uses Developer ID Application signing and Apple
   notarization instead of the unsigned preview's ad hoc signing. Use the protected
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

## Enabling the implemented workflow

`signed-preview.yml` is default-off. The unsigned `push-preview.yml` and
stable `v*` releases do not read these settings.

| Gate | GitHub settings |
| --- | --- |
| Staging (optional; keep production off) | Protect branch `ci/preview-staging`, deploy only that branch to environment `preview-staging`, and set repository variable `GITDESKTOP_PREVIEW_STAGING_ENABLED=true`. Set the environment variable `GITDESKTOP_PREVIEW_STAGING_ENDPOINT` to a distinct test HTTPS manifest URL with a normally trusted certificate. |
| Production (after sign-off) | Protect `master`, deploy only that branch to environment `preview-release`, and set repository variable `GITDESKTOP_PREVIEW_PRODUCTION_ENABLED=true` **last**. A `master` push then publishes automatically after every signed platform succeeds. Environment protection can require review if a human release gate is desired. |
| Both environments | Add each channel's own `GITDESKTOP_PREVIEW_UPDATER_PUBKEY` variable, `TAURI_SIGNING_PRIVATE_KEY` and, if set, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets, plus the six Apple credentials above for the protected macOS leg. Staging uses a disposable/never-production Tauri key and separate app ID. |

Do not stage via unreviewed PR or fork code. Push the reviewed commit to the
protected staging branch (production still off) to build A; push a second
reviewed commit there to build B. No release is created on this branch.
The three Actions artifacts are **not confidential** in this public
repository: GitHub users with access can download them. Do not embed secrets,
customer data or a credential in an endpoint URL. Only the test public key
and trusted staging URL are compiled into the app.

Download A and B from their Actions runs. To exercise native Windows and
macOS, install A on clean test machines for each platform and architecture.
Host B's normalized updater files at the test HTTPS endpoint, with the raw
contents of the adjacent `.sig` files in the corresponding JSON platform
entries. The production manifest generator in `.github/scripts/preview-release.mjs`
lists the exact platform keys; point those entries at the staging payloads,
not production GitHub Releases. Use the B version from `build.json` and the
same universal archive for both macOS architectures. Follow the two-version
gate above, including the before-consent check and relaunch. Tauri has no
official macOS desktop WebDriver, and the Linux process-local root fixture
does not apply to Windows platform trust; this workflow does not claim
either native upgrade has passed. macOS staging packaging verifies the
Developer ID signature and Gatekeeper assessment. Windows staging uses
updater signatures, not Authenticode; evaluate SmartScreen and any planned
publisher-signing separately.

Production creates a new `preview-<version>` **prerelease** with immutable
by-policy asset names and SHA-256 checks; existing published versioned assets
are never overwritten. The runner updates only the `latest.json` asset on
the separate `preview-channel` prerelease, and never makes a prerelease
GitHub's latest stable release. If repository-wide immutable releases stop
replacing the rolling asset, use a separate approved HTTPS feed instead;
do not turn off repository security settings to make it work.

GitHub's replacement of the rolling asset can briefly return 404. If that
step fails, the newest versioned prerelease still contains its validated
`latest.json`. Repair using that newest manifest, never an older one. The
publisher checks the newest **published versioned** prerelease before
promoting, even if the rolling feed is temporarily missing. Rerun **all**
matrix jobs together after a failed attempt; mixing artifacts from separate
attempts is rejected.
