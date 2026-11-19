import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, globSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const repository = "flowforever/GitDesktop";
const downloads = `https://github.com/${repository}/releases/download`;
const feedTag = "preview-channel";
const verification = ".github/test-fixtures/preview-signature/Cargo.toml";
const versionPattern = /^[1-9]\d{0,3}\.(?:0|[1-9]\d?)\.(?:0|[1-9]\d?)$/;
const slots = {
  linux: {
    os: "Linux",
    bundle: "src-tauri/target/release/bundle/appimage/*.AppImage",
    updater: "GitDesktop-Preview-linux-x86_64.AppImage",
    keys: ["linux-x86_64", "linux-x86_64-appimage"],
  },
  windows: {
    os: "Windows",
    bundle: "src-tauri/target/release/bundle/nsis/*.exe",
    updater: "GitDesktop-Preview-windows-x86_64.exe",
    keys: ["windows-x86_64", "windows-x86_64-nsis"],
  },
  macos: {
    os: "macOS",
    bundle: "src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg",
    updater: "GitDesktop-Preview-macos-universal.dmg",
    keys: ["darwin-aarch64", "darwin-aarch64-app", "darwin-x86_64", "darwin-x86_64-app"],
  },
};
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const write = (path, data) => writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
const uniqueBundle = (pattern) => {
  const files = globSync(pattern);
  assert.equal(files.length, 1, `Expected one bundle matching ${pattern}`);
  assert.ok(statSync(files[0]).size > 0);
  return files[0];
};
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

export function compareVersions(a, b) {
  assert.match(a, versionPattern);
  assert.match(b, versionPattern);
  const aa = a.split(".").map(Number);
  const bb = b.split(".").map(Number);
  return aa[0] - bb[0] || aa[1] - bb[1] || aa[2] - bb[2];
}

export function manifestFor(version, signatures, date) {
  assert.match(version, versionPattern);
  assert.equal(new Date(date).toISOString(), date);
  assert.deepEqual(Object.keys(signatures).sort(), Object.keys(slots).sort());
  const platforms = {};
  for (const [name, slot] of Object.entries(slots)) {
    const signature = signatures[name];
    assert.equal(signature, Buffer.from(signature, "base64").toString("base64"));
    assert.match(Buffer.from(signature, "base64").toString("utf8"), /^untrusted comment: signature from /);
    const value = {
      signature,
      url: `${downloads}/preview-${version}/${slot.updater}`,
    };
    // Tauri 2.14.1's updater looks up OS-arch-installer first, then OS-arch.
    // Both macOS architectures use one universal, version-signed DMG.
    for (const key of slot.keys) platforms[key] = value;
  }
  return { version, notes: "New signed GitDesktop Preview build.", pub_date: date, platforms };
}

export function validateParts(parts, expected, channel = "production") {
  assert.ok(["production", "staging"].includes(channel));
  assert.deepEqual(Object.keys(parts).sort(), Object.keys(slots).sort());
  assert.match(expected.commit, /^[0-9a-f]{40}$/);
  assert.ok(Number.isSafeInteger(expected.runNumber) && expected.runNumber >= 1);
  assert.ok(Number.isSafeInteger(expected.runAttempt) && expected.runAttempt >= 1 && expected.runAttempt <= 99);
  const sequence = (expected.runNumber - 1) * 100 + expected.runAttempt;
  const version = [1 + Math.floor(sequence / 10_000), Math.floor(sequence / 100) % 100, sequence % 100].join(".");
  assert.match(version, versionPattern);
  for (const [name, part] of Object.entries(parts)) {
    assert.deepEqual({
      version: part.version, commit: part.commit, runNumber: part.runNumber,
      runAttempt: part.runAttempt, channel: part.channel, platform: part.platform,
    }, { version, ...expected, channel, platform: slots[name].os });
  }
  return version;
}

function collect(name) {
  const slot = slots[name];
  assert.ok(slot && Object.hasOwn(slots, name));
  const tmp = process.env.RUNNER_TEMP;
  assert.ok(tmp);
  const out = join(tmp, "preview-upload");
  mkdirSync(out);
  const payload = uniqueBundle(slot.bundle);
  copyFileSync(payload, join(out, slot.updater));
  copyFileSync(`${payload}.sig`, join(out, `${slot.updater}.sig`));
  copyFileSync(join(tmp, "gitdesktop-preview-build.json"), join(out, "build.json"));
}

function validate(input, out, channel = "production") {
  mkdirSync(out);
  const expected = {
    commit: process.env.GITHUB_SHA,
    runNumber: Number(process.env.GITHUB_RUN_NUMBER),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  };
  const dirs = Object.fromEntries(Object.keys(slots).map((name) =>
    [name, join(input, `preview-signed-${expected.runAttempt}-${name}`)],
  ));
  assert.deepEqual(readdirSync(input).sort(), Object.values(dirs).map((dir) => basename(dir)).sort());
  const version = validateParts(Object.fromEntries(
    Object.entries(dirs).map(([name, dir]) => [name, read(join(dir, "build.json"))]),
  ), expected, channel);
  const pubkey = process.env.GITDESKTOP_PREVIEW_UPDATER_PUBKEY;
  assert.ok(pubkey?.trim());
  const signatures = {};
  for (const [name, dir] of Object.entries(dirs)) {
    const slot = slots[name];
    const files = ["build.json", slot.updater, `${slot.updater}.sig`];
    assert.deepEqual(readdirSync(dir).sort(), files.sort());
    for (const file of files.filter((file) => file !== "build.json")) {
      assert.ok(statSync(join(dir, file)).size > 0);
      copyFileSync(join(dir, file), join(out, file));
    }
    // The Rust verifier uses the real signature dependency and checks the
    // signed trusted-comment version only after verifying the complete bytes.
    execFileSync("cargo", ["run", "--locked", "--quiet", "--manifest-path", verification, "--",
      "verify", join(out, slot.updater), join(out, `${slot.updater}.sig`), version], {
      env: { ...process.env, GITDESKTOP_PREVIEW_UPDATER_PUBKEY: pubkey },
      stdio: "inherit",
    });
    signatures[name] = readFileSync(join(out, `${slot.updater}.sig`), "utf8").trim();
  }
  if (channel === "staging") return;
  const date = new Date().toISOString();
  write(join(out, "latest.json"), manifestFor(version, signatures, date));
  const files = Object.fromEntries(readdirSync(out).map((name) => [name, sha(join(out, name))]));
  write(join(out, "preview-build.json"), { version, commit: expected.commit, files });
}

const gh = (...args) => execFileSync("gh", args, {
  encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 300_000,
}).trim();
const allReleases = () => gh("api", "--paginate",
  `repos/${repository}/releases?per_page=100`, "--jq", ".[] | @json",
).split("\n").filter(Boolean).map((line) => JSON.parse(line));
const assetMap = (release) =>
  Object.fromEntries(release.assets.map((asset) => [asset.name, asset.digest]));
const viewTag = (tag) => JSON.parse(gh("api", `repos/${repository}/releases/tags/${tag}`));
const versionOf = (tag) => tag.startsWith("preview-") && versionPattern.test(tag.slice(8)) ? tag.slice(8) : null;

export const hasNewerPublished = (releases, version) =>
  releases.some((release) => {
    const other = versionOf(release.tag_name);
    return other && !release.draft && compareVersions(other, version) > 0;
  });

function assertCandidate(release, out, meta, draft) {
  const { version, commit, files } = meta;
  assert.equal(release.tag_name, `preview-${version}`);
  assert.ok(release.prerelease);
  assert.equal(release.draft, draft);
  assert.equal(release.target_commitish, commit);
  const hashes = Object.fromEntries(Object.entries(files).map(([name, digest]) => [name, `sha256:${digest}`]));
  hashes["preview-build.json"] = `sha256:${sha(join(out, "preview-build.json"))}`;
  assert.deepEqual(assetMap(release), hashes, "published candidate assets and digests must match");
}

function publish(out) {
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  assert.equal(process.env.GITHUB_REF, "refs/heads/master");
  const meta = read(join(out, "preview-build.json"));
  const { version, commit, files } = meta;
  assert.match(version, versionPattern);
  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.equal(commit, process.env.GITHUB_SHA);
  assert.equal(read(join(out, "latest.json")).version, version);
  const expectedFiles = [
    "latest.json", ...Object.values(slots).flatMap((slot) =>
      [slot.updater, `${slot.updater}.sig`]),
  ];
  assert.deepEqual(Object.keys(files).sort(), expectedFiles.sort());
  for (const [name, digest] of Object.entries(files)) assert.equal(sha(join(out, name)), digest);
  const tag = `preview-${version}`;
  const releases = allReleases();
  // A published immutable version is the high-water mark, independent of the
  // mutable feed asset. This also protects after an interrupted feed upload.
  if (hasNewerPublished(releases, version)) {
    console.log(`Not promoting ${tag}: a newer preview is already published.`);
    return;
  }
  let feed = releases.find((release) => release.tag_name === feedTag);
  if (!feed) {
    gh("release", "create", feedTag, "--repo", repository, "--target", commit,
      "--prerelease", "--latest=false", "--title", "GitDesktop Preview update feed",
      "--notes", "Rolling update metadata for GitDesktop Preview. Installers are attached to separate versioned previews.");
    feed = viewTag(feedTag);
  }
  assert.ok(feed.prerelease && !feed.draft && !feed.immutable, "the distinct feed prerelease must be mutable");
  if (feed.assets.some((asset) => asset.name === "latest.json")) {
    const scratch = mkdtempSync(join(tmpdir(), "preview-current-feed-"));
    try {
      gh("release", "download", feedTag, "--pattern", "latest.json", "--dir", scratch, "--repo", repository);
      const active = read(join(scratch, "latest.json")).version;
      if (compareVersions(active, version) > 0) {
        console.log(`Not promoting ${tag}: the current feed already offers a newer preview.`);
        return;
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  // GitHub ignores --target for an existing tag. Refuse a conflicting tag
  // before creating or publishing the release, not just after the fact.
  const gitRef = JSON.parse(gh("api", `repos/${repository}/git/matching-refs/tags/${tag}`))
    .find((ref) => ref.ref === `refs/tags/${tag}`);
  if (gitRef) assert.equal(gh("api", `repos/${repository}/commits/${tag}`, "--jq", ".sha"), commit);
  let candidate = releases.find((release) => release.tag_name === tag);
  if (!candidate) {
    const paths = [...Object.keys(files), "preview-build.json"].map((name) => join(out, name));
    gh("release", "create", tag, ...paths, "--repo", repository, "--target", commit,
      "--draft", "--prerelease", "--latest=false", "--title", `GitDesktop Preview ${version}`,
      "--notes", `Signed preview of commit ${commit}. This is not a stable release.`);
    candidate = allReleases().find((release) => release.tag_name === tag);
    assert.ok(candidate);
  }
  assertCandidate(candidate, out, meta, candidate.draft);
  if (candidate.draft) {
    gh("release", "edit", tag, "--repo", repository, "--draft=false", "--prerelease", "--latest=false");
  }
  const published = viewTag(tag);
  assertCandidate(published, out, meta, false);
  assert.equal(gh("api", `repos/${repository}/commits/${tag}`, "--jq", ".sha"), commit,
    "version tag must resolve to the requested commit");
  // GitHub replaces this one mutable asset; do not change immutable
  // installers. A failed replacement is repaired from the newest release.
  gh("release", "upload", feedTag, join(out, "latest.json"), "--clobber", "--repo", repository);
  assert.equal(assetMap(viewTag(feedTag))["latest.json"], `sha256:${files["latest.json"]}`);
  console.log(`Promoted signed preview ${version} (stable release unchanged).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, first, second, channel] = process.argv.slice(2);
  if (mode === "collect") collect(first);
  else if (mode === "validate") validate(first, second, channel);
  else if (mode === "publish") publish(first);
  else throw new Error("Expected collect, validate, or publish");
}
