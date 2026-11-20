import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  compareVersions, configFor, endpoint, identifier, manifestFor, nextRelease,
} from "./fork-stable-release.mjs";

const upstream = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url)));
const pubkey = Buffer.from("untrusted comment: minisign public key for a synthetic test\n").toString("base64");
const sig = Buffer.from("untrusted comment: signature from synthetic test\n").toString("base64");
const date = "2026-11-20T00:00:00.000Z";
const signatures = { linux: sig, windows: sig, macos: sig };

test("fork releases are strictly monotonic and ignore upstream and preview tags", () => {
  nextRelease("0.15.0", ["v0.15.0", "preview-1.1.1", "preview-channel"]);
  nextRelease("0.15.10", ["fork-v0.15.9"]);
  assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
  for (const version of ["0.14.99", "0.015.0", "v0.15.0", "0.15.0-rc.1", "0.15.0+1"]) {
    assert.throws(() => nextRelease(version, []));
  }
  assert.throws(() => nextRelease("0.15.0", ["fork-v0.15.0"]), /already exists/);
  assert.throws(() => nextRelease("0.15.0", ["fork-v0.16.0"]), /must increase/);
});

test("fork overlay never uses the upstream identity or signing key", () => {
  const mac = configFor("0.15.0", pubkey, true);
  assert.equal(mac.identifier, identifier);
  assert.notEqual(identifier, upstream.identifier);
  assert.equal(mac.version, "0.15.0");
  assert.equal(mac.mainBinaryName, "gitdesktop-flowforever");
  assert.equal(mac.bundle.createUpdaterArtifacts, false);
  assert.equal(mac.bundle.macOS.signingIdentity, "-");
  assert.deepEqual(mac.plugins.updater, { pubkey, endpoints: [endpoint], requireSignedVersion: true });
  assert.equal(configFor("0.15.0", pubkey, false).bundle.createUpdaterArtifacts, true);
  assert.throws(() => configFor("0.15.0", upstream.plugins.updater.pubkey), /upstream/);
  assert.throws(() => configFor("0.15.0", ""));
  assert.throws(() => configFor("0.15.0", "not-a-key"));
});

test("manifest binds every platform to an immutable fork-version tag", () => {
  const manifest = manifestFor("0.15.0", signatures, date);
  assert.equal(Object.keys(manifest.platforms).length, 8);
  assert.equal(manifest.platforms["darwin-aarch64"].url, manifest.platforms["darwin-x86_64-app"].url);
  for (const value of Object.values(manifest.platforms)) {
    assert.match(value.url, /^https:\/\/github\.com\/flowforever\/GitDesktop\/releases\/download\/fork-v0\.15\.0\//);
    assert.equal(value.signature, sig);
  }
  assert.throws(() => manifestFor("0.15.0", { linux: sig, windows: sig }, date));
  assert.throws(() => manifestFor("0.15.0", { ...signatures, linux: "garbage" }, date));
});

test("publish CLI rejects any run without explicit publication and OS disclosure", () => {
  const script = new URL("./fork-stable-release.mjs", import.meta.url);
  for (const [publish, ack] of [["false", "true"], ["true", "false"]]) {
    const result = spawnSync(process.execPath, [decodeURIComponent(script.pathname), "publish", "/not-used"], {
      encoding: "utf8",
      env: { ...process.env, FORK_STABLE_PUBLISH: publish, FORK_STABLE_ACCEPT_OS_SIGNING: ack },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /AssertionError/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
  }
});

test("installer config fails closed before building when the protected key is missing", () => {
  const script = new URL("./fork-stable-release.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [decodeURIComponent(script.pathname), "config", "macos"], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_REPOSITORY: "flowforever/GitDesktop",
      GITHUB_REF: "refs/heads/master",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_SHA: "a".repeat(40),
      FORK_STABLE_VERSION: "0.15.0",
      RUNNER_OS: "macOS",
      TAURI_SIGNING_PRIVATE_KEY: "",
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing protected fork stable signing key/);
});
