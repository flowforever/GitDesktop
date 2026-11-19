import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createServer, get } from "node:https";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const dir = process.env.GD_NATIVE_DIR;
const host = process.env.GD_NATIVE_HOST;
assert.ok(dir);
assert.equal(host, "https://127.0.0.1:18443");

const file = (...parts) => join(dir, ...parts);
const read = (...parts) => readFileSync(file(...parts), "utf8").trim();
const config = (slot) => JSON.parse(read(slot, "gitdesktop-preview-build.json"));
const { version: oldVersion } = config("a");
const { version: newVersion } = config("b");
const signature = read("b", "build.AppImage.sig");
const stats = { checks: 0, downloads: 0 };
const statsFile = file("feed-stats.json");
const setStats = () => writeFileSync(statsFile, JSON.stringify(stats));
const readStats = () => JSON.parse(read("feed-stats.json"));

function serve() {
  setStats();
  const updaterPayload = {
    url: `${host}/update.AppImage`,
    signature,
  };
  const manifest = JSON.stringify({
    version: newVersion,
    notes: "Synthetic, isolated GitDesktop Linux updater test",
    platforms: {
      "linux-x86_64": updaterPayload,
      "linux-x86_64-appimage": updaterPayload,
    },
  });
  const server = createServer(
    { cert: read("leaf.pem"), key: read("leaf.key"), minVersion: "TLSv1.2" },
    (request, response) => {
      if (request.method !== "GET") {
        response.writeHead(405).end();
        return;
      }
      if (request.url === "/health") {
        response.writeHead(200).end("ready");
      } else if (request.url === "/latest.json") {
        stats.checks += 1;
        setStats();
        response.writeHead(200, { "content-type": "application/json" }).end(manifest);
      } else if (request.url === "/update.AppImage") {
        stats.downloads += 1;
        setStats();
        response.writeHead(200, { "content-type": "application/octet-stream" });
        createReadStream(file("b", "build.AppImage")).pipe(response);
      } else {
        response.writeHead(404).end();
      }
    },
  );
  server.listen(18443, "127.0.0.1", () => console.log("loopback TLS feed ready"));
}

const waitFor = async (name, fn, milliseconds = 30_000) => {
  const end = Date.now() + milliseconds;
  let lastError;
  while (Date.now() < end) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(350);
  }
  throw new Error(`Timed out waiting for ${name}`, { cause: lastError });
};

const tlsHealth = (ca) =>
  new Promise((resolve, reject) => {
    const request = get(`${host}/health`, { ca, timeout: 5_000 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("timeout", () => request.destroy(new Error("TLS request timed out")));
    request.on("error", reject);
  });

const webdriver = async (method, path, body, milliseconds = 10_000) => {
  const response = await fetch(`http://127.0.0.1:4444${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(milliseconds),
  });
  if (response.status === 204) return null;
  const result = await response.json();
  if (!response.ok || result.value?.error) {
    throw new Error(`${method} ${path}: ${JSON.stringify(result.value)}`);
  }
  return result.value;
};

const openApp = async () => {
  const session = await webdriver(
    "POST",
    "/session",
    {
      capabilities: {
        alwaysMatch: {
          "tauri:options": { application: file("launch") },
        },
      },
    },
    35_000,
  );
  assert.ok(session.sessionId, "WebDriver did not return a session ID");
  return session.sessionId;
};

const execute = (session, script) =>
  webdriver("POST", `/session/${session}/execute/sync`, { script, args: [] });
const appVersion = (session) =>
  webdriver("POST", `/session/${session}/execute/async`, {
    script: `const done = arguments[arguments.length - 1];
      if (!window.__TAURI_INTERNALS__) return done(null);
      window.__TAURI_INTERNALS__.invoke('plugin:app|version').then(done, () => done(null));`,
    args: [],
  });
const updateRegion =
  'document.querySelector(\'section[aria-label="GitDesktop Preview update"]\')';
const updateText = (session) =>
  execute(session, `return ${updateRegion}?.textContent ?? "";`);
const hash = (...parts) =>
  createHash("sha256").update(readFileSync(file(...parts))).digest("hex");

async function test() {
  await waitFor("trusted loopback TLS feed", () => tlsHealth(read("ca.pem")));
  await assert.rejects(
    () => tlsHealth(),
    (error) => /certificate|issuer/i.test(error.message),
    "the loopback server must not be trusted without the disposable CA",
  );
  await waitFor("WebDriver readiness", async () =>
    Boolean((await webdriver("GET", "/status"))?.ready),
  );
  assert.equal(hash("installed.AppImage"), hash("a", "build.AppImage"));
  assert.notEqual(hash("installed.AppImage"), hash("b", "build.AppImage"));

  let session = await openApp();
  try {
    await waitFor("seed version", async () => (await appVersion(session)) === oldVersion);
    await waitFor("update notification", async () =>
      (await updateText(session)).includes(newVersion),
    );
    assert.equal(readStats().downloads, 0, "download started before consent");
    assert.equal(hash("installed.AppImage"), hash("a", "build.AppImage"));
    const result = await webdriver("POST", `/session/${session}/element`, {
      using: "xpath",
      value: '//section[@aria-label="GitDesktop Preview update"]//button[normalize-space()="Download and install"]',
    });
    const button = result["element-6066-11e4-a52e-4f735466cecf"];
    assert.ok(button);
    await webdriver("POST", `/session/${session}/element/${button}/click`, {});
    await waitFor("successful installation", async () =>
      (await updateText(session)).includes("Update installed"),
      60_000,
    );
    assert.equal(readStats().downloads, 1, "expected one explicit download");
    assert.equal(
      hash("installed.AppImage"),
      hash("b", "build.AppImage"),
      "the updater did not replace the on-disk AppImage with signed B",
    );
  } finally {
    await webdriver("DELETE", `/session/${session}`);
  }

  const firstChecks = readStats().checks;
  session = await openApp();
  try {
    await waitFor("B to be running after relaunch", async () =>
      (await appVersion(session)) === newVersion,
    );
    await waitFor("B to check the same manifest", () => readStats().checks > firstChecks);
    await sleep(750);
    assert.equal(await updateText(session), "");
    assert.equal(readStats().downloads, 1);
  } finally {
    await webdriver("DELETE", `/session/${session}`);
  }
  console.log(`Native signed Linux update passed: ${oldVersion} → ${newVersion}`);
}

if (process.argv[2] === "feed") serve();
else if (process.argv[2] === "test") await test();
else throw new Error("Expected feed or test");
