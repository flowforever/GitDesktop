import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const [targetArg, output] = process.argv.slice(2);
assert.ok(targetArg && output, "expected the build output and fixture record directories");
const target = resolve(targetArg);
const script = readFileSync(join(target, "nsis", "x64", "installer.nsi"), "utf8");
const main = /^!define MAINBINARYNAME "([^"\r\n]+)"\r?$/m.exec(script)?.[1];
const sourceArg = /^!define MAINBINARYSRCPATH "([^"\r\n]+)"\r?$/m.exec(script)?.[1];
assert.ok(main && sourceArg, "the rendered Tauri NSIS script must declare its main payload");
const name = `${main}.exe`;
assert.match(name, /^[\w][\w. -]*\.exe$/i, "invalid installed executable name");
const source = resolve(sourceArg);
assert.equal(dirname(source).toLowerCase(), target.toLowerCase(), "expected payload in this build's target directory");
assert.equal(basename(source).toLowerCase(), name.toLowerCase(), "NSIS File source and binary name disagree");

// Tauri patches the PE with the bundle type before makensis runs and restores
// the original build output afterwards. Pin the embedded bytes, not the
// restored output or a file produced by running either installer.
const setup = resolve(output, "setup.exe");
const sevenZip = process.platform === "win32"
  ? join(process.env.ProgramFiles ?? "C:\\Program Files", "7-Zip", "7z.exe")
  : "7z";
function nsis(args, maxBuffer) {
  const result = spawnSync(sevenZip, args, { maxBuffer, timeout: 60_000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `7-Zip cannot inspect the NSIS payload: ${result.stderr}`);
  return result.stdout;
}
const entries = nsis(["l", "-tNSIS", "-slt", "-ba", setup], 4 * 1024 * 1024)
  .toString("utf8")
  .split(/\r?\n/)
  .filter((line) => line.startsWith("Path = "))
  .map((line) => line.slice("Path = ".length))
  .filter((entry) => entry.split(/[/\\]/).at(-1)?.toLowerCase() === name.toLowerCase());
assert.equal(entries.length, 1, `expected one embedded ${name} in the signed installer`);
// Stream just the selected archive member to stdout; never unpack archive
// paths to disk or execute the setup to establish the expected hash.
const bytes = nsis(["e", "-tNSIS", "-so", "-spd", "-ssc", "-r-", setup, entries[0]], 256 * 1024 * 1024);
assert.equal(bytes.subarray(0, 2).toString("ascii"), "MZ", "embedded executable lacks PE signature");
const hash = createHash("sha256").update(bytes).digest("hex");
const rawHash = createHash("sha256").update(readFileSync(source)).digest("hex");
writeFileSync(join(output, "app.name"), `${name}\n`);
writeFileSync(join(output, "app.sha256"), `${hash}\n`);
console.log(`Embedded NSIS payload: ${entries[0]} (SHA-256 ${hash}); restored build output SHA-256: ${rawHash}`);
