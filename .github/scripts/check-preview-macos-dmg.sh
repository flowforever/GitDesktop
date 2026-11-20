#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
umask 077
fixture=$(mktemp -d)
cleanup() {
  if [ -n "${server:-}" ]; then
    kill "$server" 2>/dev/null || true
    wait "$server" 2>/dev/null || true
  fi
  rm -rf -- "$fixture"
}
trap cleanup EXIT
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
cp "$dmg" "$fixture/tampered.dmg"
printf '\nmodified\n' >> "$fixture/tampered.dmg"
if "${verifier[@]}" "$fixture/tampered.dmg" "$dmg.sig" 2.0.1 > /dev/null 2>&1; then
  echo 'DMG unexpectedly accepted after byte tampering' >&2
  exit 1
fi


cat > "$fixture/ca.cnf" <<'CONF'
[req]
prompt=no
distinguished_name=dn
x509_extensions=certificate
[dn]
CN=GitDesktop disposable test root
[certificate]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
CONF
cat > "$fixture/leaf.ext" <<'CONF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:127.0.0.1
CONF
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -config "$fixture/ca.cnf" \
  -keyout "$fixture/ca.key" -out "$fixture/ca.pem" 2>/dev/null
openssl req -new -newkey rsa:2048 -nodes -subj /CN=127.0.0.1 \
  -keyout "$fixture/leaf.key" -out "$fixture/leaf.csr" 2>/dev/null
openssl x509 -req -in "$fixture/leaf.csr" -CA "$fixture/ca.pem" \
  -CAkey "$fixture/ca.key" -CAcreateserial -days 1 -sha256 \
  -extfile "$fixture/leaf.ext" -out "$fixture/leaf.pem" 2>/dev/null
rm -f "$fixture/ca.key"

node .github/scripts/preview-macos-fixture-feed.mjs "$fixture" &
server=$!
ready=false
for _ in {1..30}; do
  if curl --silent --fail --max-time 1 --noproxy '*' --cacert "$fixture/ca.pem" \
    https://127.0.0.1:18473/health >/dev/null; then
    ready=true
    break
  fi
  sleep 0.2
done
test "$ready" = true
GD_DMG_TEST_FEED=https://127.0.0.1:18473/latest.json \
GD_DMG_TEST_PAYLOAD="$dmg" GD_DMG_TEST_CERT="$fixture/ca.pem" \
NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1 \
  cargo test --locked --manifest-path src-tauri/Cargo.toml \
    preview_update::macos::tests::downloads_and_quarantines_signed_dmg -- --ignored --exact
