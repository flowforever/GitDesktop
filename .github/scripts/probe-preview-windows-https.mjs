import { readFileSync } from "node:fs";
import { get } from "node:https";
import { setTimeout as delay } from "node:timers/promises";

const ca = readFileSync(process.argv[2]);
const url = "https://127.0.0.1:18474/health";
const retryable = new Set(["ECONNREFUSED", "ECONNRESET", "ABORT_ERR"]);

const probe = () =>
  new Promise((resolve, reject) => {
    // Use Node's TLS stack with this fixture CA instead of Schannel's
    // revocation policy. Do not override hostname/IP verification.
    const request = get(url, {
      agent: false,
      ca,
      rejectUnauthorized: true,
      signal: AbortSignal.timeout(1_000),
    }, (response) => {
      response.resume();
      if (response.statusCode === 200) resolve();
      else reject(new Error(`Unexpected health status: ${response.statusCode}`));
    });
    request.once("error", reject);
  });

for (let attempt = 1; ; attempt += 1) {
  try {
    await probe();
    break;
  } catch (cause) {
    if (attempt === 50 || !retryable.has(cause.code)) {
      throw new Error("Loopback health did not pass certificate-validated HTTPS.", { cause });
    }
    await delay(200);
  }
}
