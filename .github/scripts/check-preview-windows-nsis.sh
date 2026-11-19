#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

# Do not install packages on a self-hosted or user-owned Windows computer.
test "${GITHUB_ACTIONS:-}" = true
test "${RUNNER_ENVIRONMENT:-}" = github-hosted
test "${RUNNER_OS:-}" = Windows
umask 077
dir=$(mktemp -d "$(cygpath -u "$RUNNER_TEMP")/gd-win.XXXXXX")
export GD_WIN_FIXTURE_DIR="$(cygpath -w "$dir")"
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
cleanup() {
  code=$?
  trap - EXIT
  if [ -n "${server:-}" ]; then
    kill "$server" 2>/dev/null || true
    wait "$server" 2>/dev/null || true
  fi
  if [ "$code" -ne 0 ] && [ -f "$dir/feed.log" ]; then
    cat "$dir/feed.log"
  fi
  rm -rf -- "$dir" || echo "Runner temp cleanup incomplete; the disposable VM will be removed." >&2
  exit "$code"
}
trap cleanup EXIT

pnpm tauri signer generate --ci --password '' --write-keys "$(cygpath -w "$dir/preview.key")" >/dev/null
export GD_WIN_TEST_PUBLIC_KEY="$(cat "$dir/preview.key.pub")"
build() {
  local slot=$1 run=$2
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
  bundles=("$target/bundle/nsis"/*.exe)
  test "${#bundles[@]}" -eq 1
  test -s "${bundles[0]}.sig"
  mv "${bundles[0]}" "$output/setup.exe"
  mv "${bundles[0]}.sig" "$output/setup.exe.sig"
  sha256sum "$target/gitdesktop.exe" | cut -d' ' -f1 >"$output/app.sha256"
}
build a 1
build b 2
rm -f "$dir/preview.key"

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
cat > "$dir/leaf.ext" <<'CONF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:127.0.0.1
CONF
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -config "$dir/ca.cnf" \
  -keyout "$dir/ca.key" -out "$dir/ca.pem" 2>/dev/null
openssl req -new -newkey rsa:2048 -nodes -subj /CN=127.0.0.1 \
  -keyout "$dir/leaf.key" -out "$dir/leaf.csr" 2>/dev/null
openssl x509 -req -in "$dir/leaf.csr" -CA "$dir/ca.pem" -CAkey "$dir/ca.key" \
  -CAcreateserial -days 1 -sha256 -extfile "$dir/leaf.ext" -out "$dir/leaf.pem" 2>/dev/null
rm -f "$dir/ca.key"
export GD_WIN_TEST_CA="$(cygpath -w "$dir/ca.pem")"

node .github/scripts/preview-windows-fixture-feed.mjs "$GD_WIN_FIXTURE_DIR" >"$dir/feed.log" 2>&1 &
server=$!
ready=false
for _ in {1..50}; do
  if curl --silent --fail --max-time 1 --noproxy '*' --cacert "$dir/ca.pem" \
    https://127.0.0.1:18474/health >/dev/null; then
    ready=true
    break
  fi
  sleep 0.2
done
test "$ready" = true

pwsh -NoProfile -File .github/scripts/supervise-preview-windows-nsis.ps1
