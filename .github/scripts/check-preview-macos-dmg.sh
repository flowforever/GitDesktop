#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
umask 077
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
mkdir "$fixture/source"
printf '%s\n' 'Synthetic preview fixture, no installed app' > "$fixture/source/README.txt"
dmg="$fixture/GitDesktop-Preview-macos-universal.dmg"
hdiutil create -quiet -srcfolder "$fixture/source" -format UDZO "$dmg"
hdiutil verify "$dmg"
pnpm tauri signer generate --ci --password '' --write-keys "$fixture/preview.key" >/dev/null
TAURI_SIGNING_PRIVATE_KEY_PATH="$fixture/preview.key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD='' \
  pnpm tauri signer sign --app-version 2.0.1 "$dmg" >/dev/null
rm -f "$fixture/preview.key"
export GITDESKTOP_PREVIEW_UPDATER_PUBKEY="$(cat "$fixture/preview.key.pub")"
verifier=(cargo run --locked --quiet --manifest-path .github/test-fixtures/preview-signature/Cargo.toml -- verify)
"${verifier[@]}" "$dmg" "$dmg.sig" 2.0.1
if "${verifier[@]}" "$dmg" "$dmg.sig" 2.0.2 > /dev/null 2>&1; then
  echo 'DMG unexpectedly accepted for a forged newer version' >&2
  exit 1
fi
printf '\nmodified\n' >> "$dmg"
if "${verifier[@]}" "$dmg" "$dmg.sig" 2.0.1 > /dev/null 2>&1; then
  echo 'DMG unexpectedly accepted after byte tampering' >&2
  exit 1
fi
