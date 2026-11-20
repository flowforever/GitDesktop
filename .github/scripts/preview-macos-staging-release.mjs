import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [mode, out] = process.argv.slice(2);
assert.ok(["verify", "publish"].includes(mode) && out);
const repo = "flowforever/GitDesktop";
const [run, attempt, head] = ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SHA"].map((key) => process.env[key]);
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
assert.equal(process.env.GITHUB_REPOSITORY, repo);
assert.equal(process.env.GITHUB_REF, "refs/heads/ci/preview-mac-staging");
assert.equal(process.env.GITHUB_EVENT_NAME, "push");
assert.equal(event.head_commit.id, head);
assert.equal(event.head_commit.message.split(/\r?\n/, 1)[0], "Publish disposable macOS preview test");
assert.match(run, /^[1-9]\d*$/);
assert.match(attempt, /^[1-9]\d*$/);
assert.match(head, /^[a-f0-9]{40}$/);
const tag = `preview-mac-stage-${run}-${attempt}`;
const url = `https://github.com/${repo}/releases/download/${tag}`;
const older = "GitDesktop-Preview-Staging-A-macos-universal.dmg";
const newer = "GitDesktop-Preview-macos-universal.dmg";
const assets = [older, newer, `${older}.sig`, `${newer}.sig`, "latest.json"];
const input = [older, newer, `${older}.sig`, `${newer}.sig`, "staging.pub"];
assert.deepEqual(readdirSync(out).sort(), (mode === "verify" ? input : [...input, "latest.json"]).sort());
if (mode === "verify") {
  const pubkey = readFileSync(join(out, "staging.pub"), "utf8").trim();
  for (const [asset, version] of [[older, "1.0.1"], [newer, "1.1.1"]]) {
    execFileSync("cargo", ["run", "--locked", "--quiet", "--manifest-path",
      ".github/test-fixtures/preview-signature/Cargo.toml", "--", "verify",
      join(out, asset), join(out, `${asset}.sig`), version], {
      stdio: "inherit",
      env: { ...process.env, GITDESKTOP_PREVIEW_UPDATER_PUBKEY: pubkey },
    });
  }
  const payload = { url: `${url}/${newer}`, signature: readFileSync(join(out, `${newer}.sig`), "utf8").trim() };
  const keys = ["darwin-aarch64", "darwin-aarch64-app", "darwin-x86_64", "darwin-x86_64-app"];
  writeFileSync(join(out, "latest.json"), JSON.stringify({
    version: "1.1.1",
    notes: "Disposable GitDesktop macOS updater test, version B.",
    pub_date: new Date().toISOString(),
    platforms: Object.fromEntries(keys.map((key) => [key, payload])),
  }, null, 2) + "\n");

  console.log("Verified version-bound signatures for both macOS test packages.");
  process.exit(0);
}

const gh = (...args) => execFileSync("gh", args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
gh("release", "create", tag, "--repo", repo, "--target", head, "--draft", "--prerelease",
  "--latest=false", "--title", "GitDesktop Preview Staging · Disposable macOS test",
  "--notes", "Public interoperability test only, not a production release. Install A (1.0.1), then accept the update to B (1.1.1). Both universal disk images use a discarded test key and are not Apple-notarized.",
  ...assets.map((name) => join(out, name)));
const draft = JSON.parse(gh("release", "view", tag, "--repo", repo, "--json", "isDraft,isPrerelease,tagName,assets"));
assert.equal(draft.tagName, tag);
assert.equal(draft.isDraft, true);
assert.equal(draft.isPrerelease, true);
assert.deepEqual(draft.assets.map(({ name }) => name).sort(), assets.sort());
gh("release", "edit", tag, "--repo", repo, "--draft=false", "--prerelease", "--latest=false");
// Verify without credentials that ordinary clients can reach each final asset.
for (const name of [older, newer, "latest.json"]) {
  execFileSync("curl", ["--fail", "--silent", "--show-error", "--location", "--head",
    "--proto", "=https", "--proto-redir", "=https", "--retry", "5", "--retry-all-errors",
    "--connect-timeout", "10", "--max-time", "20", `${url}/${name}`], { stdio: ["ignore", "ignore", "inherit"] });
}
console.log(`A (1.0.1): ${url}/${older}\nB (1.1.1): ${url}/${newer}\nManifest: ${url}/latest.json`);
