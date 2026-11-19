#!/usr/bin/env bash
# PR-only offline smoke test of genuine Tauri-produced signatures.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
umask 077
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT

pnpm tauri signer generate --ci --password '' --write-keys "$fixture/preview.key" >/dev/null
pnpm tauri signer generate --ci --password '' --write-keys "$fixture/other.key" >/dev/null
printf '%s\n' 'synthetic newer preview payload' > "$fixture/new.bin"
printf '%s\n' 'synthetic older preview payload' > "$fixture/old.bin"
cp "$fixture/new.bin" "$fixture/legacy.bin"

# Pass only a private-key file path, never key bytes, on the command line.
export TAURI_SIGNING_PRIVATE_KEY_PATH="$fixture/preview.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=''
unset TAURI_SIGNING_PRIVATE_KEY
pnpm tauri signer sign --app-version 2.0.1 "$fixture/new.bin" >/dev/null
pnpm tauri signer sign --app-version 1.99.98 "$fixture/old.bin" >/dev/null
pnpm tauri signer sign "$fixture/legacy.bin" >/dev/null
unset TAURI_SIGNING_PRIVATE_KEY_PATH TAURI_SIGNING_PRIVATE_KEY_PASSWORD
rm -f -- "$fixture/preview.key" "$fixture/other.key"

GITDESKTOP_SIGNATURE_FIXTURE_DIR="$fixture" \
  cargo run --locked --quiet --manifest-path .github/test-fixtures/preview-signature/Cargo.toml
