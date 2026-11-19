import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const {
  GITHUB_OUTPUT,
  GITHUB_RUN_NUMBER,
  GITHUB_RUN_ATTEMPT,
  GITHUB_SHA,
  RUNNER_OS,
  RUNNER_TEMP,
} = process.env;
const { version: base } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);
const stable = base?.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+].*)?$/)?.[0]
  ?.split(/[-+]/)[0];
if (
  !stable ||
  !/^[1-9]\d*$/.test(GITHUB_RUN_NUMBER) ||
  !/^[1-9]\d*$/.test(GITHUB_RUN_ATTEMPT) ||
  !/^[0-9a-f]{40}$/.test(GITHUB_SHA) ||
  !["macOS", "Windows", "Linux"].includes(RUNNER_OS) ||
  !GITHUB_OUTPUT ||
  !RUNNER_TEMP
) {
  throw new Error("Missing or invalid GitDesktop version or GitHub Actions build metadata");
}

// Tauri compares the embedded app version, not the artifact filename. Use
// the workflow's run/attempt ordering, independent of upstream's base version.
// Encode each run and attempt into three numeric fields valid for macOS bundle
// metadata, Windows installer metadata and Tauri's SemVer comparison.
const runNumber = Number(GITHUB_RUN_NUMBER);
const runAttempt = Number(GITHUB_RUN_ATTEMPT);
const sequence = (runNumber - 1) * 100 + runAttempt;
if (
  runAttempt > 99 ||
  !Number.isSafeInteger(sequence) ||
  sequence >= 99_990_000
) {
  throw new Error("GitDesktop preview run number or attempt is out of range");
}
const version = [
  1 + Math.floor(sequence / 10_000),
  Math.floor(sequence / 100) % 100,
  sequence % 100,
].join(".");
const macOS = RUNNER_OS === "macOS";
const channel = process.env.GITDESKTOP_PREVIEW_SIGNING_CHANNEL;
const signed = channel === "production" || channel === "staging";
if (channel && !signed) throw new Error("Unknown preview signing channel");
const production =
  "https://github.com/flowforever/GitDesktop/releases/download/preview-channel/latest.json";
let updater = { endpoints: [] };
if (signed) {
  const pubkey = process.env.GITDESKTOP_PREVIEW_UPDATER_PUBKEY?.trim();
  const stableKey = JSON.parse(readFileSync(
    new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8",
  )).plugins.updater.pubkey;
  const endpoint = new URL(channel === "production" ? production :
    process.env.GITDESKTOP_PREVIEW_STAGING_ENDPOINT);
  if (!pubkey || pubkey === stableKey || pubkey !== Buffer.from(pubkey, "base64").toString("base64") ||
      !Buffer.from(pubkey, "base64").toString("utf8").startsWith("untrusted comment: minisign public key") ||
      endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash ||
      (channel === "staging" && endpoint.href.toLowerCase() === production.toLowerCase())) {
    throw new Error("Expected a valid preview-only public key and isolated HTTPS endpoint");
  }
  updater = { endpoints: [endpoint.href], pubkey, requireSignedVersion: true };
}
const config = {
  productName: channel === "staging" ? "GitDesktop Preview Staging" : "GitDesktop Preview",
  identifier: channel === "staging" ? "com.thebguy.gitdesktop.preview.staging" : "com.thebguy.gitdesktop.preview",
  version,
  bundle: {
    // macOS opens a separately signed DMG instead of replacing the .app.
    createUpdaterArtifacts: signed && !macOS,
    ...(macOS ? {
      macOS: {
        bundleVersion: version,
        signingIdentity: "-",
      },
    } : {}),
  },
  plugins: { updater },
};
const writeJson = (name, value) =>
  writeFileSync(join(RUNNER_TEMP, name), `${JSON.stringify(value, null, 2)}\n`);
writeJson("gitdesktop-preview.json", config);
writeJson("gitdesktop-preview-build.json", {
  version,
  baseVersion: stable,
  runNumber,
  runAttempt,
  commit: GITHUB_SHA,
  platform: RUNNER_OS,
  ...(signed ? { channel } : {}),
});
appendFileSync(GITHUB_OUTPUT, `version=${version}\n`);
