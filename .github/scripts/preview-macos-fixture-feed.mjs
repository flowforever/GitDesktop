import { createReadStream, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";

const [dir] = process.argv.slice(2);
if (!dir) throw new Error("expected disposable fixture directory");
const payloadName = "GitDesktop-Preview-macos-universal.dmg";
const payload = join(dir, payloadName);
const origin = "https://127.0.0.1:18473";
const artifact = {
  url: `${origin}/${payloadName}`,
  signature: readFileSync(`${payload}.sig`, "utf8").trim(),
};
const manifestFor = (artifact) => JSON.stringify({
  version: "2.0.1",
  platforms: {
    "darwin-aarch64": artifact,
    "darwin-aarch64-app": artifact,
    "darwin-x86_64": artifact,
    "darwin-x86_64-app": artifact,
  },
});
const manifest = manifestFor(artifact);
const tampered = manifestFor({ ...artifact, url: `${origin}/tampered/${payloadName}` });
createServer(
  {
    key: readFileSync(join(dir, "leaf.key")),
    cert: readFileSync(join(dir, "leaf.pem")),
    minVersion: "TLSv1.2",
  },
  (request, response) => {
    if (request.method !== "GET") return response.writeHead(405).end();
    switch (request.url) {
      case "/health":
        return response.writeHead(200).end("ready");
      case "/latest.json":
        return response.writeHead(200, { "content-type": "application/json" }).end(manifest);
      case "/tampered.json":
        return response.writeHead(200, { "content-type": "application/json" }).end(tampered);
      case `/tampered/${payloadName}`:
        response.writeHead(200, { "content-type": "application/octet-stream" });
        return createReadStream(join(dir, "tampered.dmg")).pipe(response);
      case `/${payloadName}`:
        response.writeHead(200, { "content-type": "application/octet-stream" });
        return createReadStream(payload).pipe(response);
      default:
        return response.writeHead(404).end();
    }
  },
).listen(18473, "127.0.0.1");
