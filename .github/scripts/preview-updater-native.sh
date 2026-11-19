#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

# The install target is a copy of A under the per-job directory, not a host app.
umask 077
GD_NATIVE_DIR=$(mktemp -d)
export GD_NATIVE_DIR
cleanup() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    for log in "$GD_NATIVE_DIR"/{driver,feed}.log; do
      if [ -f "$log" ]; then tail -n 70 "$log"; fi
    done
  fi
  for pid in "${driver_pid:-}" "${feed_pid:-}"; do
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
  done
  rm -rf -- "$GD_NATIVE_DIR"
  exit "$status"
}
trap cleanup EXIT
export GD_NATIVE_HOST=https://127.0.0.1:18443
mkdir -p "$GD_NATIVE_DIR"/{a,b,home,cache,config,data,runtime,cert-dir}

# Signed leaf for the loopback IP only. The process-local CA is not installed
# into the runner's trust store and is never passed to build or package tools.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj /CN=GitDesktop-ephemeral-CI-root \
  -addext basicConstraints=critical,CA:TRUE,pathlen:0 \
  -addext keyUsage=critical,keyCertSign,cRLSign \
  -keyout "$GD_NATIVE_DIR/ca.key" -out "$GD_NATIVE_DIR/ca.pem" 2>/dev/null
openssl req -new -newkey rsa:2048 -nodes -subj /CN=127.0.0.1 \
  -keyout "$GD_NATIVE_DIR/leaf.key" -out "$GD_NATIVE_DIR/leaf.csr" 2>/dev/null
cat > "$GD_NATIVE_DIR/leaf.ext" <<'EXT'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:127.0.0.1
EXT
openssl x509 -req -in "$GD_NATIVE_DIR/leaf.csr" -CA "$GD_NATIVE_DIR/ca.pem" \
  -CAkey "$GD_NATIVE_DIR/ca.key" -CAcreateserial -days 1 -sha256 \
  -extfile "$GD_NATIVE_DIR/leaf.ext" -out "$GD_NATIVE_DIR/leaf.pem"
openssl verify -CAfile "$GD_NATIVE_DIR/ca.pem" -verify_ip 127.0.0.1 "$GD_NATIVE_DIR/leaf.pem"
rm -f "$GD_NATIVE_DIR/ca.key"

pnpm tauri signer generate --ci --password '' --write-keys "$GD_NATIVE_DIR/preview.key" >/dev/null
build_preview() {
  local slot=$1 run=$2
  local targetdir=src-tauri/target/release/bundle/appimage
  local dir="$GD_NATIVE_DIR/$slot"
  GITHUB_RUN_NUMBER=$run GITHUB_RUN_ATTEMPT=1 GITHUB_OUTPUT="$dir/output" \
    RUNNER_TEMP="$dir" RUNNER_OS=Linux node .github/scripts/preview-config.mjs

  node --input-type=module - "$dir" <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2];
const file = join(dir, "gitdesktop-preview.json");
const config = JSON.parse(readFileSync(file, "utf8"));
config.bundle.createUpdaterArtifacts = true;
config.plugins.updater = {
  endpoints: [`${process.env.GD_NATIVE_HOST}/latest.json`],
  pubkey: readFileSync(join(process.env.GD_NATIVE_DIR, "preview.key.pub"), "utf8").trim(),
  requireSignedVersion: true,
};
writeFileSync(file, JSON.stringify(config));
JS

  local -a previous
  shopt -s nullglob
  previous=("$targetdir"/*.AppImage "$targetdir"/*.AppImage.sig)
  if (( ${#previous[@]} )); then
    # The dedicated runner builds only these two throwaway packages.
    printf 'Unexpected leftover AppImage output; refusing to overwrite it.\n' >&2
    return 1
  fi
  VITE_GITDESKTOP_PREVIEW_UPDATES=1 \
    TAURI_SIGNING_PRIVATE_KEY="$(cat "$GD_NATIVE_DIR/preview.key")" \
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD='' \
    pnpm tauri build --bundles appimage --config "$dir/gitdesktop-preview.json"
  bash .github/scripts/appimage-guard.sh
  local -a packages=("$targetdir"/*.AppImage)
  test "${#packages[@]}" -eq 1
  test -s "${packages[0]}.sig"
  mv "${packages[0]}" "$dir/build.AppImage"
  mv "${packages[0]}.sig" "$dir/build.AppImage.sig"
}

build_preview a 1
build_preview b 2
rm -f "$GD_NATIVE_DIR/preview.key"
cp "$GD_NATIVE_DIR/a/build.AppImage" "$GD_NATIVE_DIR/installed.AppImage"
chmod u+x "$GD_NATIVE_DIR/installed.AppImage"

# FUSE-free execution follows AppImage's own extract-and-run path. The AppImage
# runtime supplies APPIMAGE to Tauri, so the real updater replaces the CI copy.
cat > "$GD_NATIVE_DIR/launch" <<'APP'
#!/usr/bin/env bash
set -euo pipefail
export APPIMAGE_EXTRACT_AND_RUN=1
export SSL_CERT_FILE="$GD_NATIVE_DIR/ca.pem" SSL_CERT_DIR="$GD_NATIVE_DIR/cert-dir"
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
export HOME="$GD_NATIVE_DIR/home" XDG_CONFIG_HOME="$GD_NATIVE_DIR/config"
export XDG_CACHE_HOME="$GD_NATIVE_DIR/cache" XDG_DATA_HOME="$GD_NATIVE_DIR/data"
export XDG_RUNTIME_DIR="$GD_NATIVE_DIR/runtime"
exec "$GD_NATIVE_DIR/installed.AppImage" "$@"
APP
chmod u+x "$GD_NATIVE_DIR/launch"

node .github/scripts/preview-updater-native.mjs feed >"$GD_NATIVE_DIR/feed.log" 2>&1 &
feed_pid=$!
xvfb-run -a dbus-run-session -- tauri-driver --native-driver /usr/bin/WebKitWebDriver >"$GD_NATIVE_DIR/driver.log" 2>&1 &
driver_pid=$!
timeout -k 5 240 node .github/scripts/preview-updater-native.mjs test
