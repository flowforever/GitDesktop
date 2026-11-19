import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const run = (runner, number, attempt) => {
  const dir = mkdtempSync(join(tmpdir(), "gitdesktop-preview-test-"));
  try {
    const output = join(dir, "output");
    const { status, stderr } = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./preview-config.mjs", import.meta.url))],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          RUNNER_OS: runner,
          RUNNER_TEMP: dir,
          GITHUB_OUTPUT: output,
          GITHUB_RUN_NUMBER: String(number),
          GITHUB_RUN_ATTEMPT: String(attempt),
          GITHUB_SHA: "f".repeat(40),
        },
      },
    );
    if (status !== 0) return { status, stderr };
    const read = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));
    return {
      status,
      config: read("gitdesktop-preview.json"),
      manifest: read("gitdesktop-preview-build.json"),
      output: readFileSync(output, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("all runners embed the same version while keeping previews isolated", () => {
  for (const runner of ["Linux", "Windows", "macOS"]) {
    const { status, config, manifest, output } = run(runner, 100, 2);
    assert.equal(status, 0);
    assert.equal(config.version, "1.99.2");
    assert.equal(manifest.version, config.version);
    assert.equal(config.identifier, "com.thebguy.gitdesktop.preview");
    assert.equal(config.bundle.createUpdaterArtifacts, false);
    assert.deepEqual(config.plugins.updater.endpoints, []);
    assert.equal(output, "version=1.99.2\n");
    if (runner === "macOS") {
      assert.equal(config.bundle.macOS.bundleVersion, config.version);
    }
  }
});

test("run rollover and retries always advance the installed app version", () => {
  assert.equal(run("Linux", 100, 1).config.version, "1.99.1");
  assert.equal(run("Linux", 100, 99).config.version, "1.99.99");
  assert.equal(run("Linux", 101, 1).config.version, "2.0.1");
  assert.equal(run("Linux", 999900, 99).config.version, "9999.99.99");
  assert.match(run("Linux", 100, 100).stderr, /out of range/);
  assert.match(run("Linux", 999901, 1).stderr, /out of range/);
});
