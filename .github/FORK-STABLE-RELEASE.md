# Stable releases of the flowforever fork

The fork's stable builds are named **GitDesktop Flowforever**, use application
ID `io.github.flowforever.gitdesktop`, and use their own stored data and
credential namespace. They are installed separately from upstream and staging.
Fork versions follow SemVer, beginning with `0.15.0`; public tags use
`fork-v0.15.0`, so the inherited upstream `v*` tag workflow does not run.
Only this workflow should make a fork release Latest. Its dedicated
`fork-stable.json` asset is part of the validated release, and its update
payloads always point to immutable versioned URLs. The preview channels are
unchanged.

## One-time owner setup

1. On a trusted machine, generate a **new, durable fork-only** Tauri updater
   keypair, for example `pnpm tauri signer generate --write-keys ~/.config/gitdesktop-flowforever/stable.key`.
   Use a passphrase and keep an offline recovery copy. Do not use upstream,
   preview, or disposable staging keys; never send the key through chat or
   commit it.
2. In the fork's GitHub Settings, create **fork-stable-signing**. Restrict
   deployments to the `master` branch and configure trusted approval if
   available. Put the private key in its environment secret
   `FORK_STABLE_TAURI_SIGNING_PRIVATE_KEY`, its passphrase in
   `FORK_STABLE_TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and put **only the matching
   public key** in the repository Actions variable
   `GITDESKTOP_FORK_STABLE_UPDATER_PUBKEY`.
3. Create **fork-stable-publish**, also restricted to `master`, and require
   a trusted reviewer. It needs no signing secrets. Keep this separate from
   approval to build. No credentials belong in pull requests or build artifacts.

## Build, inspect, publish

Dispatch **fork-stable-release** on the fork's trusted `master` with version
`0.15.0` and `publish=false` (the default). Wait for all three platform jobs and
the independent version/signature checks. Inspect the candidate artifact;
do not distribute a candidate as a release. The workflow rejects missing
signing inputs, stale source, existing version tags/releases, missing/extra
assets, and mismatched signed versions. There is no automatic publication when
master changes.

The macOS universal installer is **ad hoc signed and not Apple-notarized**.
Windows has **no Authenticode signature**. Tauri updater signatures are separate:
they verify the upgrade bytes and version but do not confer OS signing trust.
Do not disable Gatekeeper, SmartScreen, HTTPS checks, or signature checks.
A build-only run makes no releases and does not change update feeds.

After reviewing all packages and getting explicit approval to publish with
these OS-signing limitations, dispatch the same version with `publish=true` and
`accept_os_signing_status=true`, then review/approve the protected publishing
job. It will rebuild and verify the same code, upload and check a draft, and
only then publish it. Do not publish a draft manually or substitute a personal
access token: the workflow's built-in token stops GitHub from running inherited
release-event workflows that belong to upstream. The first stable build is installed manually; future
versions are offered through its separate update feed. On macOS a verified
installer is opened before the app requests a guarded quit, so the user can
replace the app. On Windows and Linux the updater installs it and asks the
user to restart.
