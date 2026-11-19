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
const config = {
  productName: "GitDesktop Preview",
  identifier: "com.thebguy.gitdesktop.preview",
  version,
  bundle: {
    createUpdaterArtifacts: false,
    ...(macOS ? {
      macOS: {
        bundleVersion: version,
        signingIdentity: "-",
      },
    } : {}),
  },
  plugins: { updater: { endpoints: [] } },
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
});
appendFileSync(GITHUB_OUTPUT, `version=${version}\n`);
