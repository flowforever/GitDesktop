import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";

const [dir] = process.argv.slice(2);
if (!dir) throw new Error("expected disposable fixture directory");
const payload = join(dir, "b", "setup.exe");
const artifact = {
  url: "https://127.0.0.1:18474/update.exe",
  signature: readFileSync(`${payload}.sig`, "utf8").trim(),
};
const manifest = JSON.stringify({
  version: "1.1.1",
  platforms: {
    "windows-x86_64": artifact,
    "windows-x86_64-nsis": artifact,
  },
});
let downloads = 0;
writeFileSync(join(dir, "downloads"), "0");
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
      case "/update.exe":
        writeFileSync(join(dir, "downloads"), String(++downloads));
        response.writeHead(200, { "content-type": "application/octet-stream" });
        return createReadStream(payload).pipe(response);
      default:
        return response.writeHead(404).end();
    }
  },
).listen(18474, "127.0.0.1");
