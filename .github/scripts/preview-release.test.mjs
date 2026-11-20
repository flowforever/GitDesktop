import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, hasNewerPublished, manifestFor, validateParts } from "./preview-release.mjs";

const encode = (value) => Buffer.from(value).toString("base64");
const fakeSignature = encode("untrusted comment: signature from test secret key\nsynthetic");
const signatures = { linux: fakeSignature, windows: fakeSignature, macos: fakeSignature };
const expected = {
  runNumber: 101,
  runAttempt: 1,
  commit: "3".repeat(40),
};
const makeParts = () => Object.fromEntries(
  [["linux", "Linux"], ["windows", "Windows"], ["macos", "macOS"]].map(([name, platform]) =>
    [name, { ...expected, version: "2.0.1", channel: "production", platform }],
  ),
);

test("manifest contains official installer-qualified keys and immutable URLs", () => {
  const m = manifestFor("2.0.1", signatures, "2026-11-19T00:00:00.000Z");
  assert.deepEqual(Object.keys(m.platforms).sort(), [
    "darwin-aarch64", "darwin-aarch64-app", "darwin-x86_64", "darwin-x86_64-app",
    "linux-x86_64", "linux-x86_64-appimage", "windows-x86_64", "windows-x86_64-nsis",
  ]);
  for (const part of Object.values(m.platforms)) {
    assert.match(part.url, /^https:\/\/github\.com\/flowforever\/GitDesktop\/releases\/download\/preview-2\.0\.1\//);
    assert.equal(part.signature, fakeSignature);
  }
  assert.deepEqual(m.platforms["darwin-aarch64-app"], m.platforms["darwin-x86_64-app"]);
  assert.match(m.platforms["darwin-aarch64-app"].url, /universal\.dmg$/);
  assert.match(m.platforms["windows-x86_64-nsis"].url, /\.exe$/);
  assert.match(m.platforms["linux-x86_64-appimage"].url, /\.AppImage$/);
  assert.throws(() => manifestFor("2.0.1", { ...signatures, linux: "junk" }, m.pub_date));
  assert.throws(() => manifestFor("2.0.1", { linux: fakeSignature }, m.pub_date));
  assert.throws(() => manifestFor("2.0.1", signatures, "yesterday"));
});

test("all packaging legs must agree on trusted SHA, attempt, slot and channel", () => {
  assert.equal(validateParts(makeParts(), expected), "2.0.1");
  for (const mismatch of [
    { runAttempt: 2 }, { runNumber: 100 }, { commit: "4".repeat(40) },
    { version: "2.0.2" }, { platform: "Linux" }, { channel: "staging" },
  ]) {
    const parts = makeParts();
    Object.assign(parts.macos, mismatch);
    assert.throws(() => validateParts(parts, expected));
  }
  assert.throws(() => validateParts({ linux: makeParts().linux }, expected));
});

test("rollback comparison is numeric, not lexicographical", () => {
  assert.ok(compareVersions("1.99.99", "2.0.1") < 0);
  assert.ok(compareVersions("2.9.99", "2.10.1") < 0);
  assert.ok(compareVersions("2.10.3", "2.10.2") > 0);
  assert.equal(compareVersions("2.10.2", "2.10.2"), 0);
  assert.throws(() => compareVersions("2.010.2", "2.10.2"));
});

test("a published newer preview blocks retry promotion, even without a rolling feed", () => {
  const existing = [
    { tag_name: "v100.0.0", draft: false },
    { tag_name: "preview-channel", draft: false },
    { tag_name: "preview-3.0.1", draft: true },
    { tag_name: "preview-2.0.1", draft: false },
  ];
  assert.equal(hasNewerPublished(existing, "1.99.99"), true);
  assert.equal(hasNewerPublished(existing, "2.0.1"), false);
  assert.equal(hasNewerPublished(existing, "2.0.2"), false);
});
