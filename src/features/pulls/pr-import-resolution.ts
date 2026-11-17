export interface PrImportResolutionOptions {
  sourcePath: string;
  specifier: string;
  paths: ReadonlySet<string>;
  readText: (path: string) => Promise<string | null>;
}

const MAX_READS = 48;
const MAX_CONFIG_DEPTH = 8;
const MAX_PACKAGE_MANIFESTS = 32;
const MAX_JSON_CHARS = 256_000;
const EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".json",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".styl",
];
const BUILTINS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "sqlite",
  "stream",
  "string_decoder",
  "test",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);
type JsonObject = Record<string, unknown>;
type Config = {
  baseUrl?: string;
  aliases?: { origin: string; entries: [string, string[]][] };
};

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function excludedPath(path: string): boolean {
  return path
    .split("/")
    .some((part) => part === "node_modules" || part === ".git");
}

/** Git paths use forward slashes; normalization never leaves the snapshot root. */
function normalize(path: string): string | null {
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    /^[\w+.-]+:/.test(path)
  )
    return null;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

const directory = (path: string) =>
  path.slice(0, Math.max(0, path.lastIndexOf("/")));
const join = (base: string, path: string) =>
  path.startsWith("/") || /^[\w+.-]+:/.test(path)
    ? null
    : normalize(base ? `${base}/${path}` : path);

/** Two lexical passes preserve quoted URLs, escaped quotes, and comma characters. */
function parseJsonc(text: string): JsonObject | null {
  if (text.length > MAX_JSON_CHARS) return null;
  let clean = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      clean += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      clean += char;
    } else if (char === "/" && text[index + 1] === "/") {
      while (index + 1 < text.length && text[index + 1] !== "\n") index++;
      clean += " ";
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end === -1) return null;
      index = end + 1;
      clean += " ";
    } else clean += char;
  }
  let strict = "";
  quoted = false;
  escaped = false;
  for (let index = 0; index < clean.length; index++) {
    const char = clean[index];
    if (!quoted && char === ",") {
      let next = index + 1;
      while (/\s/.test(clean[next] ?? "") && next < clean.length) next++;
      if (clean[next] === "}" || clean[next] === "]") continue;
    }
    strict += char;
    if (quoted && escaped) escaped = false;
    else if (quoted && char === "\\") escaped = true;
    else if (char === '"') quoted = !quoted;
  }
  try {
    return object(JSON.parse(strict.replace(/^\uFEFF/, "")));
  } catch {
    return null;
  }
}

function matchPattern(pattern: string, value: string): string | null {
  const star = pattern.indexOf("*");
  if (star === -1) return pattern === value ? "" : null;
  if (pattern.indexOf("*", star + 1) !== -1) return null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return value.startsWith(prefix) &&
    value.endsWith(suffix) &&
    value.length >= prefix.length + suffix.length
    ? value.slice(prefix.length, value.length - suffix.length)
    : null;
}

function specificity(a: string, b: string): number {
  const first = a.indexOf("*");
  const second = b.indexOf("*");
  if (first === -1 || second === -1)
    return Number(second === -1) - Number(first === -1);
  return second - first || b.length - a.length;
}

function workspaceGlob(pattern: string, value: string): boolean {
  let expression = "^";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      expression += ".*";
      index++;
    } else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${expression}$`).test(value);
}

export async function resolvePrImport({
  sourcePath,
  specifier,
  paths,
  readText,
}: PrImportResolutionOptions): Promise<string | null> {
  const source = normalize(sourcePath);
  if (
    !source ||
    !specifier ||
    specifier.includes("\\") ||
    specifier.includes("\0") ||
    /^[\w+.-]+:/.test(specifier) ||
    specifier.startsWith("//")
  )
    return null;

  function resolvePath(path: string | null): string | null {
    if (path === null || excludedPath(path)) return null;
    if (paths.has(path)) return path;
    const substitution = path.match(/\.(js|mjs|cjs)$/);
    if (substitution) {
      const variants =
        substitution[1] === "mjs"
          ? [".mts", ".d.mts"]
          : substitution[1] === "cjs"
            ? [".cts", ".d.cts"]
            : [".ts", ".tsx", ".d.ts"];
      for (const extension of variants) {
        const candidate = path.slice(0, -substitution[0].length) + extension;
        if (paths.has(candidate)) return candidate;
      }
    }
    if (EXTENSIONS.some((extension) => path.endsWith(extension))) return null;
    if (path)
      for (const extension of EXTENSIONS) {
        if (paths.has(path + extension)) return path + extension;
      }
    for (const extension of EXTENSIONS) {
      const index = `${path ? `${path}/` : ""}index${extension}`;
      if (paths.has(index)) return index;
    }
    return null;
  }

  if (specifier.startsWith("./") || specifier.startsWith("../"))
    return resolvePath(join(directory(source), specifier));
  if (specifier.startsWith("/"))
    return resolvePath(normalize(specifier.slice(1)));
  const segments = specifier.split("/");
  const scoped = specifier.startsWith("@");
  const packageName = segments.slice(0, scoped ? 2 : 1).join("/");
  if (BUILTINS.has(packageName)) return null;

  let reads = 0;
  const jsonCache = new Map<string, Promise<JsonObject | null>>();
  function readJson(path: string): Promise<JsonObject | null> {
    const cached = jsonCache.get(path);
    if (cached) return cached;
    if (!paths.has(path) || excludedPath(path) || reads >= MAX_READS)
      return Promise.resolve(null);
    reads++;
    const pending = (async () => {
      try {
        const text = await readText(path);
        return text === null ? null : parseJsonc(text);
      } catch {
        return null;
      }
    })();
    jsonCache.set(path, pending);
    return pending;
  }

  async function config(
    path: string,
    depth = 0,
    seen = new Set<string>(),
  ): Promise<Config> {
    if (depth >= MAX_CONFIG_DEPTH || seen.has(path)) return {};
    const body = await readJson(path);
    if (!body) return {};
    const branch = new Set(seen).add(path);
    const origin = directory(path);
    let inherited: Config = {};
    if (typeof body.extends === "string" && body.extends.startsWith(".")) {
      const parent = join(origin, body.extends);
      if (parent !== null) {
        const found = [parent, `${parent}.json`].find((candidate) =>
          paths.has(candidate),
        );
        if (found) inherited = await config(found, depth + 1, branch);
      }
    }
    const options = object(body.compilerOptions);
    if (!options) return inherited;
    const result = { ...inherited };
    if (typeof options.baseUrl === "string") {
      const base = join(origin, options.baseUrl);
      if (base !== null) result.baseUrl = base;
    }
    const aliases = object(options.paths);
    if (aliases)
      result.aliases = {
        origin,
        entries: Object.entries(aliases)
          .slice(0, 128)
          .flatMap(([pattern, targets]) =>
            Array.isArray(targets)
              ? [
                  [
                    pattern,
                    targets
                      .filter(
                        (target): target is string =>
                          typeof target === "string",
                      )
                      .slice(0, 16),
                  ] as [string, string[]],
                ]
              : [],
          ),
      };
    return result;
  }

  for (let dir = directory(source); ; dir = directory(dir)) {
    const primary = ["tsconfig.json", "jsconfig.json"]
      .map((name) => (dir ? `${dir}/${name}` : name))
      .find((path) => paths.has(path));
    const app = dir ? `${dir}/tsconfig.app.json` : "tsconfig.app.json";
    if (primary || paths.has(app)) {
      for (const path of [primary, paths.has(app) ? app : undefined]) {
        if (!path) continue;
        const settings = await config(path);
        const alias = settings.aliases?.entries
          .filter(([pattern]) => matchPattern(pattern, specifier) !== null)
          .sort(([a], [b]) => specificity(a, b))[0];
        if (alias) {
          const captured = matchPattern(alias[0], specifier) ?? "";
          for (const target of alias[1]) {
            const substituted = target.replace("*", captured);
            if (substituted.startsWith("/") || /^[\w+.-]+:/.test(substituted))
              continue;
            const resolved = resolvePath(
              join(
                settings.baseUrl ?? settings.aliases?.origin ?? "",
                substituted,
              ),
            );
            if (resolved) return resolved;
          }
        }
        if (settings.baseUrl !== undefined) {
          const resolved = resolvePath(join(settings.baseUrl, specifier));
          if (resolved) return resolved;
        }
      }
      break;
    }
    if (dir === "") break;
  }

  if (scoped && (segments.length < 2 || segments[0].length < 2 || !segments[1]))
    return null;
  const root = await readJson("package.json");
  const workspaces = root?.workspaces;
  const declared = Array.isArray(workspaces)
    ? workspaces
    : object(workspaces)?.packages;
  const patterns = Array.isArray(declared)
    ? declared
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, 64)
    : null;
  const manifests = [...paths]
    .filter((path) => {
      if (path !== "package.json" && !path.endsWith("/package.json"))
        return false;
      if (excludedPath(path)) return false;
      if (!patterns || path === "package.json") return true;
      const dir = directory(path);
      return (
        patterns.some(
          (pattern) => !pattern.startsWith("!") && workspaceGlob(pattern, dir),
        ) &&
        !patterns.some(
          (pattern) =>
            pattern.startsWith("!") && workspaceGlob(pattern.slice(1), dir),
        )
      );
    })
    .sort();
  if (
    manifests.length > MAX_PACKAGE_MANIFESTS ||
    manifests.length > MAX_READS - reads + Number(jsonCache.has("package.json"))
  )
    return null;
  const matches: { path: string; body: JsonObject }[] = [];
  for (const path of manifests) {
    const body = await readJson(path);
    if (body?.name === packageName) matches.push({ path, body });
  }
  if (matches.length !== 1) return null;
  const manifest = matches[0];
  const packageRoot = directory(manifest.path);
  const subpath = segments.slice(scoped ? 2 : 1).join("/");
  if (subpath.split("/").some((part) => part === ".." || part === "."))
    return null;
  const entry = (value: unknown) =>
    typeof value === "string" &&
    !value.startsWith("/") &&
    !/^[\w+.-]+:/.test(value)
      ? resolvePath(join(packageRoot, value))
      : null;
  if (!subpath) {
    const sourceEntry = entry(manifest.body.source);
    if (sourceEntry) return sourceEntry;
  }

  function exportTarget(
    value: unknown,
    captured: string,
    depth = 0,
  ): string | null {
    if (depth >= MAX_CONFIG_DEPTH) return null;
    if (typeof value === "string") {
      if (!value.startsWith("./")) return null;
      const target = join(packageRoot, value.replace("*", captured));
      if (
        target === null ||
        (packageRoot && !target.startsWith(`${packageRoot}/`))
      )
        return null;
      return resolvePath(target);
    }
    if (Array.isArray(value)) {
      for (const candidate of value.slice(0, 16)) {
        const target = exportTarget(candidate, captured, depth + 1);
        if (target) return target;
      }
    } else {
      const conditions = object(value);
      if (conditions)
        for (const condition of [
          "source",
          "development",
          "import",
          "module",
          "browser",
          "default",
          "require",
          "types",
        ]) {
          const target = exportTarget(
            conditions[condition],
            captured,
            depth + 1,
          );
          if (target) return target;
        }
    }
    return null;
  }
  if (Object.hasOwn(manifest.body, "exports")) {
    const exports = manifest.body.exports;
    const mapping = object(exports);
    if (mapping && Object.keys(mapping).some((key) => key.startsWith("."))) {
      const name = subpath ? `./${subpath}` : ".";
      const pattern = Object.keys(mapping)
        .filter((key) => matchPattern(key, name) !== null)
        .sort(specificity)[0];
      return pattern
        ? exportTarget(mapping[pattern], matchPattern(pattern, name) ?? "")
        : null;
    }
    return subpath ? null : exportTarget(exports, "");
  }
  if (subpath) return resolvePath(join(packageRoot, subpath));
  return (
    entry(manifest.body.module) ??
    entry(manifest.body.main) ??
    resolvePath(join(packageRoot, "index"))
  );
}
