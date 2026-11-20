// Fork-only, manual release tooling. Preview and upstream channels are separate.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, globSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const repository = "flowforever/GitDesktop";
export const identifier = "io.github.flowforever.gitdesktop";
export const manifestName = "fork-stable.json";
const downloadRoot = `https://github.com/${repository}/releases/download`;
export const endpoint = `https://github.com/${repository}/releases/latest/download/${manifestName}`;
const versionPattern = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;
const slots = {
  linux: {
    runner: "Linux", glob: "src-tauri/target/release/bundle/appimage/*.AppImage",
    installer: "GitDesktop-Flowforever-linux-x86_64.AppImage",
    platforms: ["linux-x86_64", "linux-x86_64-appimage"],
  },
  windows: {
    runner: "Windows", glob: "src-tauri/target/release/bundle/nsis/*.exe",
    installer: "GitDesktop-Flowforever-windows-x86_64.exe",
    platforms: ["windows-x86_64", "windows-x86_64-nsis"],
  },
  macos: {
    runner: "macOS", glob: "src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg",
    installer: "GitDesktop-Flowforever-macos-universal.dmg",
    platforms: ["darwin-aarch64", "darwin-aarch64-app", "darwin-x86_64", "darwin-x86_64-app"],
  },
};
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const write = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const tagFor = (version) => `fork-v${version}`;
const nameFor = (slot) => `fork-stable-${process.env.GITHUB_RUN_ATTEMPT}-${slot}`;
const assets = Object.values(slots).flatMap(({ installer }) => [installer, `${installer}.sig`]);

export function compareVersions(a, b) {
  assert.match(a, versionPattern);
  assert.match(b, versionPattern);
  const aa = a.split(".").map(Number);
  const bb = b.split(".").map(Number);
  return aa[0] - bb[0] || aa[1] - bb[1] || aa[2] - bb[2];
}

export function nextRelease(version, existing) {
  assert.ok(compareVersions(version, "0.15.0") >= 0, "Expected fork stable 0.15.0 or newer");
  for (const tag of existing) {
    assert.notEqual(tag, tagFor(version), "Release or tag already exists");
    if (tag.startsWith("fork-v") && versionPattern.test(tag.slice(6))) {
      assert.ok(compareVersions(version, tag.slice(6)) > 0, "Fork stable version must increase");
    }
  }
}

function checkedPubkey(pubkey) {
  assert.ok(pubkey, "Configure GITDESKTOP_FORK_STABLE_UPDATER_PUBKEY");
  assert.equal(pubkey, Buffer.from(pubkey, "base64").toString("base64"));
  assert.match(Buffer.from(pubkey, "base64").toString("utf8"), /^untrusted comment: minisign public key/);
  const upstream = read(new URL("../../src-tauri/tauri.conf.json", import.meta.url)).plugins.updater.pubkey;
  assert.notEqual(pubkey, upstream, "Do not use upstream signing identity");
  return pubkey;
}

export function configFor(version, pubkey, macOS) {
  nextRelease(version, []);
  const upstream = read(new URL("../../src-tauri/tauri.conf.json", import.meta.url));
  return {
    productName: "GitDesktop Flowforever",
    mainBinaryName: "gitdesktop-flowforever",
    identifier,
    version,
    app: { windows: upstream.app.windows.map((window) => ({ ...window, title: "GitDesktop Flowforever" })) },
    bundle: {
      createUpdaterArtifacts: !macOS,
      ...(macOS ? { macOS: { bundleVersion: version, signingIdentity: "-" } } : {}),
    },
    plugins: {
      updater: { endpoints: [endpoint], pubkey: checkedPubkey(pubkey), requireSignedVersion: true },
    },
  };
}

export function manifestFor(version, signatures, date) {
  nextRelease(version, []);
  assert.equal(new Date(date).toISOString(), date);
  assert.deepEqual(Object.keys(signatures).sort(), Object.keys(slots).sort());
  return {
    version, pub_date: date,
    notes: "GitDesktop Flowforever stable update. macOS builds are not Apple-notarized.",
    platforms: Object.fromEntries(Object.entries(slots).flatMap(([name, slot]) => {
      const signature = signatures[name];
      assert.ok(signature);
      assert.equal(signature, Buffer.from(signature, "base64").toString("base64"));
      assert.match(Buffer.from(signature, "base64").toString("utf8"), /^untrusted comment: signature from /);
      return slot.platforms.map((key) => [key, {
        signature, url: `${downloadRoot}/${tagFor(version)}/${slot.installer}`,
      }]);
    })),
  };
}

function current() {
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  assert.equal(process.env.GITHUB_REF, "refs/heads/master");
  assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
  const commit = process.env.GITHUB_SHA;
  const version = process.env.FORK_STABLE_VERSION;
  assert.match(commit, /^[0-9a-f]{40}$/);
  nextRelease(version, []);
  return { commit, version };
}

function configure(slotName) {
  const { version, commit } = current();
  const slot = slots[slotName];
  assert.ok(Object.hasOwn(slots, slotName));
  assert.equal(slot.runner, process.env.RUNNER_OS);
  assert.ok(process.env.TAURI_SIGNING_PRIVATE_KEY?.trim(), "Missing protected fork stable signing key");
  const tmp = process.env.RUNNER_TEMP;
  write(join(tmp, "fork-stable-config.json"), configFor(version, process.env.GITDESKTOP_FORK_STABLE_UPDATER_PUBKEY, slotName === "macos"));
  write(join(tmp, "fork-stable-build.json"), { commit, version, slot: slotName, attempt: Number(process.env.GITHUB_RUN_ATTEMPT) });
}

function regular(path) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && stat.size > 0, `Expected nonempty regular file: ${path}`);
}

function collect(slotName) {
  current();
  assert.ok(Object.hasOwn(slots, slotName));
  const slot = slots[slotName];
  const [bundle, ...extra] = globSync(slot.glob);
  assert.ok(bundle && extra.length === 0, "Expected exactly one platform bundle");
  const out = join(process.env.RUNNER_TEMP, "fork-stable-part");
  mkdirSync(out);
  for (const suffix of ["", ".sig"]) {
    regular(bundle + suffix);
    copyFileSync(bundle + suffix, join(out, slot.installer + suffix));
  }
  copyFileSync(join(process.env.RUNNER_TEMP, "fork-stable-build.json"), join(out, "build.json"));
}

function checkNames(path, expected) {
  assert.deepEqual(readdirSync(path).sort(), [...expected].sort(), "Unexpected/missing files");
}

function validate(input, out) {
  const meta = current();
  const pubkey = checkedPubkey(process.env.GITDESKTOP_FORK_STABLE_UPDATER_PUBKEY);
  checkNames(input, Object.keys(slots).map(nameFor));
  mkdirSync(out);
  const signatures = {};
  for (const [name, slot] of Object.entries(slots)) {
    const from = join(input, nameFor(name));
    checkNames(from, ["build.json", slot.installer, `${slot.installer}.sig`]);
    assert.deepEqual(read(join(from, "build.json")), {
      ...meta, slot: name, attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    });
    const installer = join(from, slot.installer);
    for (const path of [installer, installer + ".sig"]) regular(path);
    execFileSync("cargo", ["run", "--locked", "--quiet", "--manifest-path",
      ".github/test-fixtures/preview-signature/Cargo.toml", "--", "verify", installer, installer + ".sig", meta.version], {
      stdio: "inherit",
      env: { ...process.env, GITDESKTOP_PREVIEW_UPDATER_PUBKEY: pubkey },
    });
    signatures[name] = readFileSync(installer + ".sig", "utf8").trim();
    copyFileSync(installer, join(out, slot.installer));
    copyFileSync(installer + ".sig", join(out, slot.installer + ".sig"));
  }
  write(join(out, manifestName), manifestFor(meta.version, signatures, new Date().toISOString()));
  write(join(out, "BUILD.json"), { ...meta, files: Object.fromEntries(
    [...assets, manifestName].map((name) => [name, sha(join(out, name))]),
  ) });
}

const gh = (...args) => execFileSync("gh", args, {
  encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 300_000,
}).trim();
const apiLines = (path, query) => gh("api", "--paginate", `repos/${repository}/${path}`, "--jq", query).split("\n").filter(Boolean);

function preflight() {
  const { commit, version } = current();
  assert.equal(gh("api", `repos/${repository}/commits/master`, "--jq", ".sha"), commit,
    "Refuse publishing a build from a stale master");
  const refs = apiLines("git/matching-refs/tags/fork-v", '.[] | .ref | sub("^refs/tags/"; "")');
  const releases = apiLines("releases?per_page=100", ".[] | .tag_name");
  nextRelease(version, [...refs, ...releases]);
}

function assertRelease(data, tag, commit, digests, draft) {
  assert.equal(data.tag_name, tag);
  assert.equal(data.target_commitish, commit);
  assert.equal(data.prerelease, false);
  assert.equal(data.draft, draft);
  assert.equal(data.assets.length, Object.keys(digests).length);
  assert.deepEqual(Object.fromEntries(data.assets.map(({ name, digest }) => [name, digest])), digests);
}

function publish(out) {
  assert.equal(process.env.FORK_STABLE_PUBLISH, "true");
  assert.equal(process.env.FORK_STABLE_ACCEPT_OS_SIGNING, "true");
  const { commit, version } = current();
  const names = [...assets, manifestName, "BUILD.json"];
  checkNames(out, names);
  for (const name of names) regular(join(out, name));
  const meta = read(join(out, "BUILD.json"));
  assert.deepEqual(meta, { commit, version, files: Object.fromEntries(
    [...assets, manifestName].map((name) => [name, sha(join(out, name))]),
  ) });
  const stored = read(join(out, manifestName));
  const signatures = Object.fromEntries(Object.entries(slots).map(([name, { installer }]) =>
    [name, readFileSync(join(out, installer + ".sig"), "utf8").trim()]));
  assert.deepEqual(stored, manifestFor(version, signatures, stored.pub_date));
  const digests = Object.fromEntries(names.map((name) => [name, `sha256:${sha(join(out, name))}`]));
  preflight();
  const tag = tagFor(version);
  gh("release", "create", tag, ...names.map((name) => join(out, name)), "--repo", repository,
    "--target", commit, "--draft", "--latest=false", "--title", `GitDesktop Flowforever ${version}`,
    "--notes", "Official release of the flowforever fork. Includes merge request tabs, code navigation, MR chat and signed updates. The macOS installer is ad hoc signed and not Apple-notarized; the Windows installer is not Authenticode-signed. Updater signatures are independent of OS signing.");
  const draft = apiLines("releases?per_page=100", ".[] | @json")
    .map((line) => JSON.parse(line)).find((release) => release.tag_name === tag);
  assert.ok(draft, "The newly created draft could not be verified");
  assertRelease(draft, tag, commit, digests, true);
  gh("release", "edit", tag, "--repo", repository, "--draft=false", "--latest");
  const published = JSON.parse(gh("api", `repos/${repository}/releases/tags/${tag}`));
  assertRelease(published, tag, commit, digests, false);
  assert.equal(gh("api", `repos/${repository}/commits/${tag}`, "--jq", ".sha"), commit);
  assert.equal(gh("api", `repos/${repository}/releases/latest`, "--jq", ".tag_name"), tag);
  console.log(`Published ${tag} to ${repository}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, a, b] = process.argv.slice(2);
  if (mode === "config") configure(a);
  else if (mode === "collect") collect(a);
  else if (mode === "preflight") preflight();
  else if (mode === "validate") validate(a, b);
  else if (mode === "publish") publish(a);
  else throw new Error("Expected config, collect, preflight, validate, or publish");
}
