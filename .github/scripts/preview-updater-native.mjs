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
        console.log(`served manifest #${stats.checks}`);
        response.writeHead(200, { "content-type": "application/json" }).end(manifest);
      } else if (request.url === "/update.AppImage") {
        stats.downloads += 1;
        setStats();
        console.log(`served signed payload #${stats.downloads}`);
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

const phase = process.argv[2];
const port = process.env.GD_WEBDRIVER_PORT;
const stage = async (name, fn) => {
  console.log(`[${phase}] START ${name}`);
  try {
    const result = await fn();
    console.log(`[${phase}] PASS ${name}`);
    return result;
  } catch (cause) {
    throw new Error(`[${phase}] FAILED ${name}`, { cause });
  }
};
const webdriver = async (method, path, body, milliseconds = 10_000) => {
  assert.match(port ?? "", /^444[46]$/);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(milliseconds),
    });
    if (response.status === 204) return null;
    const result = await response.json();
    if (!response.ok || result.value?.error) {
      throw new Error(`HTTP ${response.status}: ${JSON.stringify(result.value)}`);
    }
    return result.value;
  } catch (cause) {
    throw new Error(`WebDriver ${method} ${path} (deadline ${milliseconds} ms)`, { cause });
  }
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

async function waitForDriver() {
  await stage("WebDriver readiness", () =>
    waitFor("WebDriver /status ready", async () =>
      Boolean((await webdriver("GET", "/status"))?.ready),
    ),
  );
}

async function testSeed() {
  await stage("loopback TLS trust and rejection", async () => {
    await waitFor("trusted loopback TLS feed", () => tlsHealth(read("ca.pem")));
    await assert.rejects(
      () => tlsHealth(),
      (error) => /certificate|issuer/i.test(error.message),
      "the loopback server must not be trusted without the disposable CA",
    );
  });
  await waitForDriver();
  assert.equal(hash("installed.AppImage"), hash("a", "build.AppImage"));
  assert.notEqual(hash("installed.AppImage"), hash("b", "build.AppImage"));

  const session = await stage("open A WebDriver session", openApp);
  await stage(`read seed version ${oldVersion}`, () =>
    waitFor("seed version", async () => (await appVersion(session)) === oldVersion),
  );
  await stage(`show prompt for ${newVersion} without downloading`, async () => {
    await waitFor("update notification", async () =>
      (await updateText(session)).includes(newVersion),
    );
    assert.equal(readStats().downloads, 0, "download started before consent");
    assert.equal(hash("installed.AppImage"), hash("a", "build.AppImage"));
  });
  await stage("accept update and verify replacement bytes", async () => {
    const result = await webdriver("POST", `/session/${session}/element`, {
      using: "xpath",
      value: '//section[@aria-label="GitDesktop Preview update"]//button[normalize-space()="Download and install"]',
    });
    const button = result["element-6066-11e4-a52e-4f735466cecf"];
    assert.ok(button);
    await webdriver("POST", `/session/${session}/element/${button}/click`, {});
    const resultText = await waitFor("installation outcome", async () => {
      const notice = await updateText(session);
      return /Update installed|could not be installed/.test(notice) && notice;
    }, 60_000);
    assert.match(resultText, /Update installed/, resultText);
    assert.equal(readStats().downloads, 1, "expected one explicit download");
    assert.equal(
      hash("installed.AppImage"),
      hash("b", "build.AppImage"),
      "the updater did not replace the on-disk AppImage with signed B",
    );
  });
  // The shell closes this entire disposable WebDriver/Xvfb/D-Bus group so B
  // cannot reuse stale WebKit automation processes from the seed session.
}

async function testRelaunch() {
  const firstChecks = readStats().checks;
  assert.equal(readStats().downloads, 1, "expected exactly one earlier download");
  assert.equal(hash("installed.AppImage"), hash("b", "build.AppImage"));
  await waitForDriver();
  const session = await stage("open B WebDriver session in fresh desktop", openApp);
  await stage(`read version ${newVersion} after relaunch`, () =>
    waitFor("B to be running after relaunch", async () =>
      (await appVersion(session)) === newVersion,
    ),
  );
  await stage("recheck manifest without offering or downloading B again", async () => {
    await waitFor("B to check the same manifest", () => readStats().checks > firstChecks);
    await sleep(750);
    assert.equal(await updateText(session), "");
    assert.equal(readStats().downloads, 1);
  });
  console.log(`Native signed Linux update passed: ${oldVersion} → ${newVersion}`);
}

if (phase === "feed") serve();
else if (phase === "test-a") await testSeed();
else if (phase === "test-b") await testRelaunch();
else throw new Error("Expected feed, test-a or test-b");
