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

const version = `${stable}-preview.${GITHUB_RUN_NUMBER}.${GITHUB_RUN_ATTEMPT}`;
const macOS = RUNNER_OS === "macOS";
// Keep the Mac's CFBundleShortVersionString numeric. Its CFBundleVersion
// tracks the build/run, while the archive records the full preview SemVer.
const config = {
  productName: "GitDesktop Preview",
  identifier: "com.thebguy.gitdesktop.preview",
  version: macOS ? stable : version,
  bundle: {
    createUpdaterArtifacts: false,
    ...(macOS ? {
      macOS: {
        bundleVersion: `${GITHUB_RUN_NUMBER}.${GITHUB_RUN_ATTEMPT}`,
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
  appVersion: config.version,
  commit: GITHUB_SHA,
  platform: RUNNER_OS,
});
appendFileSync(GITHUB_OUTPUT, `version=${version}\n`);
