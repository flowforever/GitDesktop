#!/usr/bin/env bash
set -Eeuo pipefail
stage=startup
trap 'printf "Windows updater fixture failed at stage %s (line %s, exit %s)\n" "$stage" "$LINENO" "$?" >&2' ERR
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

# Do not install packages on a self-hosted or user-owned Windows computer.
test "${GITHUB_ACTIONS:-}" = true
test "${RUNNER_ENVIRONMENT:-}" = github-hosted
test "${RUNNER_OS:-}" = Windows
umask 077
dir=$(mktemp -d "$(cygpath -u "$RUNNER_TEMP")/gd-win.XXXXXX")
export GD_WIN_FIXTURE_DIR="$(cygpath -w "$dir")"
# The follow-up step runs in a clean shell with the same disposable runner disk.
printf 'GD_WIN_FIXTURE_DIR=%s\n' "$GD_WIN_FIXTURE_DIR" >> "$(cygpath -u "$GITHUB_ENV")"
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
handoff=false
cleanup() {
  code=$?
  trap - EXIT
  if [ "$code" -eq 0 ] && [ "$handoff" != true ]; then
    printf 'Native Windows acceptance did not complete installer handoff.\n' >&2
    code=1
  fi
  if [ -n "${server:-}" ]; then
    kill "$server" 2>/dev/null || true
    wait "$server" 2>/dev/null || true
  fi
  if [ "$code" -ne 0 ] && [ -f "$dir/feed.log" ]; then
    cat "$dir/feed.log"
  fi
  rm -f -- "$dir/preview.key" "$dir/ca.key" "$dir/leaf.key"
  exit "$code"
}
trap cleanup EXIT

pnpm tauri signer generate --ci --password '' --write-keys "$(cygpath -w "$dir/preview.key")" >/dev/null
export GD_WIN_TEST_PUBLIC_KEY="$(cat "$dir/preview.key.pub")"
build() {
  local slot=$1 run=$2
  stage="build-$slot"
  printf 'START: build signed fixture %s\n' "$slot"
  local target=src-tauri/target/release
  local output="$dir/$slot"
  mkdir "$output"
  local win_output
  win_output=$(cygpath -w "$output")
  GITHUB_RUN_NUMBER=$run GITHUB_RUN_ATTEMPT=1 GITHUB_OUTPUT="$(cygpath -w "$output/meta")" \
    RUNNER_TEMP="$win_output" RUNNER_OS=Windows node .github/scripts/preview-config.mjs

  node --input-type=module - "$win_output" <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const path = join(process.argv[2], "gitdesktop-preview.json");
const config = JSON.parse(readFileSync(path, "utf8"));
config.productName = "GitDesktop Preview Windows CI";
config.identifier = "com.thebguy.gitdesktop.preview.windowsci";
config.bundle.windows = { nsis: { installMode: "currentUser" } };
config.bundle.createUpdaterArtifacts = true;
// Signing here tests the real installer format. The normal application does
// not fetch this fixture feed: only the separately compiled Rust test does.
config.plugins.updater = {
  endpoints: [],
  pubkey: process.env.GD_WIN_TEST_PUBLIC_KEY,
  requireSignedVersion: true,
};
writeFileSync(path, JSON.stringify(config));
JS
  local -a bundles
  shopt -s nullglob
  bundles=("$target/bundle/nsis"/*.exe)
  test "${#bundles[@]}" -eq 0
  TAURI_SIGNING_PRIVATE_KEY="$(cat "$dir/preview.key")" \
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD='' VITE_GITDESKTOP_PREVIEW_UPDATES=0 \
    pnpm tauri build --bundles nsis --config "$(cygpath -w "$output/gitdesktop-preview.json")"
  stage="collect-$slot"
  bundles=("$target/bundle/nsis"/*.exe)
  if [ "${#bundles[@]}" -ne 1 ]; then
    printf 'Expected exactly one NSIS installer for %s, found %s\n' "$slot" "${#bundles[@]}" >&2
    return 1
  fi
  test -s "${bundles[0]}.sig"
  mv "${bundles[0]}" "$output/setup.exe"
  mv "${bundles[0]}.sig" "$output/setup.exe.sig"
  node .github/scripts/record-preview-windows-payload.mjs "$target" "$win_output"
  printf 'PASS: collected installer, signature and executable hash for %s\n' "$slot"
}
build a 1
build b 2
rm -f "$dir/preview.key"

stage=make-loopback-certificates
printf '%s\n' 'START: create disposable loopback TLS certificates'
cat > "$dir/ca.cnf" <<'CONF'
[req]
prompt=no
distinguished_name=dn
x509_extensions=certificate
[dn]
CN=GitDesktop disposable Windows fixture root
[certificate]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
CONF
cat > "$dir/leaf.cnf" <<'CONF'
[req]
prompt=no
distinguished_name=dn
[dn]
CN=127.0.0.1
CONF
cat > "$dir/leaf.ext" <<'CONF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:127.0.0.1
CONF
# OpenSSL receives only relative files and no slash-prefixed subject.
# Git Bash/MSYS otherwise treats '/CN=...' as a Windows file argument.
(
  cd "$dir"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -config ca.cnf \
    -keyout ca.key -out ca.pem
  openssl req -new -newkey rsa:2048 -nodes -config leaf.cnf \
    -keyout leaf.key -out leaf.csr
  openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key \
    -CAcreateserial -days 1 -sha256 -extfile leaf.ext -out leaf.pem
  openssl verify -CAfile ca.pem -verify_ip 127.0.0.1 leaf.pem
)
printf '%s\n' 'PASS: loopback TLS chain and IP SAN verify'
rm -f "$dir/ca.key"
export GD_WIN_TEST_CA="$(cygpath -w "$dir/ca.pem")"

stage=start-loopback-feed
printf '%s\n' 'START: start and probe loopback HTTPS feed'
node .github/scripts/preview-windows-fixture-feed.mjs "$GD_WIN_FIXTURE_DIR" >"$dir/feed.log" 2>&1 &
server=$!
node .github/scripts/probe-preview-windows-https.mjs "$GD_WIN_TEST_CA"
printf '%s\n' 'PASS: loopback HTTPS feed ready'
stage=supervise-native-install
pwsh -NoProfile -File .github/scripts/supervise-preview-windows-nsis.ps1
stage=verify-installer-handoff
if [ ! -f "$dir/native-handoff-completed" ] ||
   [ "$(cat "$dir/native-handoff-completed")" != "$(cat "$dir/b/app.sha256")" ]; then
  printf 'Missing or incorrect native installer handoff marker.\n' >&2
  exit 1
fi
handoff=true
printf 'PASS: signed Tauri updater handed off to native NSIS\n'
