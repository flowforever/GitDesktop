#!/usr/bin/env bash
set -euo pipefail
test "${GITHUB_REPOSITORY:-}" = flowforever/GitDesktop
test "${GITHUB_REF:-}" = refs/heads/ci/preview-mac-staging
test "${GITHUB_EVENT_NAME:-}" = push
test "${RUNNER_OS:-}" = macOS
[[ "$GITHUB_RUN_ID" =~ ^[1-9][0-9]*$ && "$GITHUB_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]
tag="preview-mac-stage-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
export GITDESKTOP_PREVIEW_SIGNING_CHANNEL=staging
export GITDESKTOP_PREVIEW_STAGING_ENDPOINT="https://github.com/flowforever/GitDesktop/releases/download/$tag/latest.json"
export VITE_GITDESKTOP_PREVIEW_UPDATES=1
umask 077
scratch=$(mktemp -d "$RUNNER_TEMP/gd-mac-stage.XXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
out="$RUNNER_TEMP/gd-mac-stage-assets"
mkdir "$out"
unset TAURI_SIGNING_PRIVATE_KEY
export TAURI_SIGNING_PRIVATE_KEY_PATH="$scratch/disposable.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=''
pnpm tauri signer generate --ci --password '' --write-keys "$TAURI_SIGNING_PRIVATE_KEY_PATH" >/dev/null
export GITDESKTOP_PREVIEW_UPDATER_PUBKEY="$(cat "$TAURI_SIGNING_PRIVATE_KEY_PATH.pub")"
cp "$TAURI_SIGNING_PRIVATE_KEY_PATH.pub" "$out/staging.pub"
shopt -s nullglob
# Tauri may remove the intermediate macOS bundle after creating the DMG.
# Inspect the exact disk image that will be signed, never the build directory.
inspect_image() (
  local image="$1" version="$2" mountpoint executable
  mountpoint=$(mktemp -d "$scratch/dmg-mount.XXXXXX")
  trap 'hdiutil detach "$mountpoint" >/dev/null' EXIT
  hdiutil attach "$image" -readonly -nobrowse -mountpoint "$mountpoint"
  local apps=("$mountpoint"/*.app)
  test "${#apps[@]}" -eq 1
  test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${apps[0]}/Contents/Info.plist")" = "$version"
  executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "${apps[0]}/Contents/Info.plist")
  [[ -n "$executable" && "$executable" != */* ]]
  lipo -verify_arch x86_64 arm64 "${apps[0]}/Contents/MacOS/$executable"
  hdiutil detach "$mountpoint"
  trap - EXIT
  rmdir "$mountpoint"
)

build() {
  local seq="$1" filename="$2" version
  local dir='src-tauri/target/universal-apple-darwin/release/bundle'
  GITHUB_RUN_NUMBER="$seq" GITHUB_RUN_ATTEMPT=1 RUNNER_TEMP="$scratch" GITHUB_OUTPUT="$scratch/out" \
    node .github/scripts/preview-config.mjs
  pnpm tauri build --bundles dmg --target universal-apple-darwin --config "$scratch/gitdesktop-preview.json"
  local images=("$dir"/dmg/*.dmg)
  test "${#images[@]}" -eq 1
  version=$(node -p 'require(process.argv[1]).version' "$scratch/gitdesktop-preview-build.json")
  hdiutil verify "${images[0]}"
  inspect_image "${images[0]}" "$version"
  mv "${images[0]}" "$out/$filename"
  pnpm tauri signer sign --app-version "$version" "$out/$filename"
}
build 1 GitDesktop-Preview-Staging-A-macos-universal.dmg
build 2 GitDesktop-Preview-macos-universal.dmg
