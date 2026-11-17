export interface CodeImportResolutionOptions {
  sourcePath: string;
  specifier: string;
  kind?: string;
  paths: ReadonlySet<string>;
  readText: (path: string) => Promise<string | null>;
}

const MAX_READS = 48;
const MAX_TEXT = 400_000;
const MAX_CANDIDATES = 64;
const PYTHON_BUILTINS = new Set([
  "os",
  "sys",
  "typing",
  "json",
  "re",
  "math",
  "collections",
  "datetime",
  "itertools",
  "functools",
  "asyncio",
  "unittest",
  "subprocess",
  "logging",
  "dataclasses",
  "urllib",
  "http",
  "email",
  "threading",
  "multiprocessing",
  "importlib",
  "inspect",
  "types",
  "enum",
  "abc",
  "socket",
  "sqlite3",
  "csv",
  "io",
  "random",
  "time",
  "uuid",
  "builtins",
  "pathlib",
]);
const RUBY_BUILTINS = new Set([
  "json",
  "set",
  "date",
  "time",
  "fileutils",
  "pathname",
  "open-uri",
  "socket",
  "openssl",
  "yaml",
  "logger",
  "pp",
  "ostruct",
  "stringio",
  "erb",
  "csv",
  "tempfile",
]);
const C_SYSTEM = new Set([
  "stdio.h",
  "stdlib.h",
  "stdint.h",
  "stdbool.h",
  "stddef.h",
  "string.h",
  "math.h",
  "assert.h",
  "errno.h",
  "time.h",
  "unistd.h",
  "limits.h",
  "vector",
  "string",
  "map",
  "set",
  "unordered_map",
  "unordered_set",
  "memory",
  "iostream",
  "utility",
  "algorithm",
  "array",
  "tuple",
  "functional",
  "optional",
  "variant",
  "type_traits",
]);
const SWIFT_BUILTINS = new Set([
  "Swift",
  "Foundation",
  "SwiftUI",
  "UIKit",
  "AppKit",
  "Combine",
  "Darwin",
  "Glibc",
  "XCTest",
]);

function excluded(path: string): boolean {
  return path
    .split("/")
    .some((part) => part === "node_modules" || part === ".git");
}

function normal(path: string): string | null {
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    /^[\w+.-]+:/.test(path)
  )
    return null;
  const result: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!result.length) return null;
      result.pop();
    } else result.push(part);
  }
  const value = result.join("/");
  return excluded(value) ? null : value;
}

function join(base: string, path: string): string | null {
  return path.startsWith("/") || /^[\w+.-]+:/.test(path)
    ? null
    : normal(base ? `${base}/${path}` : path);
}
const dir = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const under = (path: string, root: string) =>
  !root || path.startsWith(`${root}/`);
const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const withoutComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, " ");

/** Keep offsets/newlines while hiding non-code declarations in source proofs. */
function declarationCode(text: string, path: string): string {
  const masked = text.split("");
  const lowerPath = path.toLowerCase();
  const swift = lowerPath.endsWith(".swift");
  const kotlin = lowerPath.endsWith(".kt");
  const csharp = lowerPath.endsWith(".cs");
  const escapedTriple = swift || lowerPath.endsWith(".java");
  const hide = (start: number, end: number) => {
    for (let index = start; index < end; index++)
      if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " ";
  };
  function closing(
    marker: string,
    from: number,
    escapePrefix?: string,
  ): number {
    let end = text.indexOf(marker, from);
    while (end !== -1 && escapePrefix) {
      const before = text.slice(Math.max(0, end - escapePrefix.length), end);
      if (before !== escapePrefix) break;
      if (escapePrefix === "\\") {
        let slashes = 0;
        for (let index = end - 1; index >= 0 && text[index] === "\\"; index--)
          slashes++;
        if (slashes % 2 === 0) break;
      }
      end = text.indexOf(marker, end + marker.length);
    }
    return end === -1 ? text.length : end + marker.length;
  }
  for (let index = 0; index < text.length; ) {
    const start = index;
    if (text.startsWith("//", index)) {
      while (
        index < text.length &&
        text[index] !== "\r" &&
        text[index] !== "\n"
      )
        index++;
      hide(start, index);
      continue;
    }
    if (text.startsWith("/*", index)) {
      index += 2;
      let depth = 1;
      while (index < text.length && depth) {
        if ((swift || kotlin) && text.startsWith("/*", index)) {
          depth++;
          index += 2;
        } else if (text.startsWith("*/", index)) {
          depth--;
          index += 2;
        } else index++;
      }
      hide(start, index);
      continue;
    }
    // C++ raw strings may contain both quotes and comment-like text.
    if (text.startsWith('R"', index)) {
      const relativeOpen = text.slice(index + 2, index + 19).indexOf("(");
      const open = relativeOpen === -1 ? -1 : index + 2 + relativeOpen;
      const delimiter = open === -1 ? null : text.slice(index + 2, open);
      if (delimiter !== null && /^[^\s()\\]{0,16}$/.test(delimiter)) {
        index = closing(`)${delimiter}"`, open + 1);
        hide(start, index);
        continue;
      }
    }
    let hashes = 0;
    if (swift) while (text[index + hashes] === "#") hashes++;
    if (hashes && text[index + hashes] === '"') {
      const quote = index + hashes;
      const width = text.startsWith('"""', quote) ? 3 : 1;
      const suffix = "#".repeat(hashes);
      index = closing(
        `${'"'.repeat(width)}${suffix}`,
        quote + width,
        `\\${suffix}`,
      );
      hide(start, index);
      continue;
    }
    if (hashes) {
      index += hashes;
      continue;
    }
    if (text[index] === '"' || text[index] === "'") {
      const quote = text[index];
      let width = 1;
      if (quote === '"' && text.startsWith('"""', index)) {
        width = 3;
        if (csharp) while (text[index + width] === '"') width++;
      }
      if (width >= 3) {
        index = closing(
          '"'.repeat(width),
          index + width,
          escapedTriple ? "\\" : undefined,
        );
      } else {
        const verbatim =
          csharp &&
          (text[index - 1] === "@" ||
            (text[index - 2] === "@" && text[index - 1] === "$"));
        index++;
        while (index < text.length) {
          if (verbatim && text[index] === quote && text[index + 1] === quote)
            index += 2;
          else if (!verbatim && text[index] === "\\")
            index = Math.min(index + 2, text.length);
          else if (text[index++] === quote) break;
        }
      }
      hide(start, index);
      continue;
    }
    index++;
  }
  return masked.join("");
}

/** Resolve source declarations in the selected commit, never installed dependencies. */
export async function resolveCodeImportCandidates({
  sourcePath,
  specifier,
  kind,
  paths,
  readText,
}: CodeImportResolutionOptions): Promise<string[]> {
  const source = normal(sourcePath);
  const language = languageForPath(sourcePath);
  if (
    !source ||
    !language ||
    !specifier ||
    specifier.length > 4096 ||
    /[\0\r\n]/.test(specifier)
  )
    return [];
  const files = [...paths]
    .filter((path) => normal(path) === path && path !== "")
    .sort();
  const finish = (candidates: (string | null)[]) =>
    [
      ...new Set(
        candidates.filter(
          (path): path is string =>
            path !== null && paths.has(path) && !excluded(path),
        ),
      ),
    ]
      .sort()
      .slice(0, MAX_CANDIDATES);
  let reads = 0;
  const cache = new Map<string, Promise<string | null>>();
  function read(path: string): Promise<string | null> {
    const cached = cache.get(path);
    if (cached) return cached;
    if (!paths.has(path) || excluded(path) || reads >= MAX_READS)
      return Promise.resolve(null);
    reads++;
    const result = (async () => {
      try {
        const text = await readText(path);
        return text !== null && text.length <= MAX_TEXT ? text : null;
      } catch {
        return null;
      }
    })();
    cache.set(path, result);
    return result;
  }
  const ancestors: string[] = [];
  for (let root = dir(source); ; root = dir(root)) {
    ancestors.push(root);
    if (!root) break;
  }
  function closest(names: string[]): string | null {
    for (const root of ancestors)
      for (const name of names) {
        const path = join(root, name);
        if (path && paths.has(path)) return path;
      }
    return null;
  }
  function closestSuffix(suffix: string): string | null {
    for (const root of ancestors) {
      const path = files.find(
        (candidate) => dir(candidate) === root && candidate.endsWith(suffix),
      );
      if (path) return path;
    }
    return null;
  }
  const sourceParts = source.split("/");
  function inferredRoot(): string {
    const parts = sourceParts;
    const cut = parts.findIndex(
      (part) => part === "src" || part === "lib" || part === "Sources",
    );
    return cut === -1 ? "" : parts.slice(0, cut).join("/");
  }
  function projectRoot(markers: string[]): string {
    const marker = closest(markers);
    return marker ? dir(marker) : inferredRoot();
  }
  function packageFiles(
    root: string | null,
    extensions: string[],
    recursive = false,
  ): string[] {
    if (root === null) return [];
    return files.filter(
      (path) =>
        under(path, root) &&
        (recursive || dir(path) === root) &&
        extensions.some((extension) => path.endsWith(extension)),
    );
  }
  async function prove(
    candidates: string[],
    predicate: (text: string, path: string) => boolean,
  ): Promise<string[]> {
    const result: string[] = [];
    for (const path of [...new Set(candidates)]) {
      if (reads >= MAX_READS && !cache.has(path)) break;
      const text = await read(path);
      if (text !== null && predicate(declarationCode(text, path), path))
        result.push(path);
      if (result.length >= MAX_CANDIDATES) break;
    }
    return finish(result);
  }
  if (language === "javascript") {
    const target = await resolvePrImport({
      sourcePath,
      specifier,
      paths,
      readText: read,
    });
    return finish([target]);
  }

  if (language === "python") {
    if (!/^\.*(?:[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\.\*)?)?$/.test(specifier))
      return [];
    const dots = specifier.match(/^\.+/)?.[0].length ?? 0;
    const parts = specifier
      .slice(dots)
      .replace(/\.\*$/, "")
      .split(".")
      .filter(Boolean);
    if (!dots && PYTHON_BUILTINS.has(parts[0])) return [];
    const marker = closest(["pyproject.toml", "setup.cfg", "setup.py"]);
    let packageTop: string | null = null;
    for (const ancestor of ancestors) {
      if (!paths.has(`${ancestor ? `${ancestor}/` : ""}__init__.py`)) break;
      packageTop = ancestor;
    }
    let roots: string[];
    if (dots) {
      let base = dir(source);
      for (let level = 1; level < dots; level++) {
        if (!base) return [];
        base = dir(base);
      }
      if (
        packageTop !== null &&
        base !== packageTop &&
        !under(base, packageTop)
      )
        return [];
      roots = [base];
    } else if (packageTop !== null) roots = [dir(packageTop)];
    else {
      const root = marker ? dir(marker) : inferredRoot();
      roots = [join(root, "src") ?? root, root];
    }
    for (
      let count = parts.length;
      count >= (parts.length && !dots ? 1 : 0);
      count--
    ) {
      for (const root of roots) {
        const stem = join(root, parts.slice(0, count).join("/"));
        if (stem === null) continue;
        const exact = finish([
          `${stem}/__init__.py`,
          `${stem}.py`,
          `${stem}.pyi`,
        ]);
        if (exact.length)
          return [
            exact.find((path) => path.endsWith("/__init__.py")) ?? exact[0],
          ];
        if (count === parts.length && count > 0) {
          const namespace = packageFiles(stem, [".py", ".pyi"]);
          if (namespace.length) return finish(namespace);
        }
      }
    }
    return [];
  }

  if (language === "go") {
    if (
      specifier.includes("\\") ||
      specifier.startsWith(".") ||
      specifier.startsWith("/") ||
      specifier.includes(":")
    )
      return [];
    const mods = new Set<string>();
    const own = closest(["go.mod"]);
    if (own) mods.add(own);
    const work = closest(["go.work"]);
    if (work) {
      const text = withoutComments((await read(work)) ?? "");
      const uses = [...text.matchAll(/\buse\s*\(([\s\S]*?)\)/g)].flatMap(
        (match) => match[1].match(/"[^"]+"|`[^`]+`|\S+/g) ?? [],
      );
      const singles = text.replace(/\buse\s*\([\s\S]*?\)/g, "");
      uses.push(
        ...[...singles.matchAll(/^\s*use\s+("[^"]+"|`[^`]+`|\S+)/gm)].map(
          (match) => match[1],
        ),
      );
      for (const use of uses.slice(0, MAX_READS)) {
        const root = join(dir(work), use.replace(/^["`]|["`]$/g, ""));
        const path = root === null ? null : join(root, "go.mod");
        if (path && paths.has(path)) mods.add(path);
      }
    }
    const modules: { root: string; name: string }[] = [];
    for (const path of mods) {
      const text = withoutComments((await read(path)) ?? "");
      const name = text
        .match(/^\s*module\s+(?:"([^"]+)"|(\S+))/m)
        ?.slice(1)
        .find(Boolean);
      if (name && (specifier === name || specifier.startsWith(`${name}/`)))
        modules.push({ root: dir(path), name });
    }
    const longest = Math.max(0, ...modules.map((entry) => entry.name.length));
    return finish(
      modules
        .filter((entry) => entry.name.length === longest)
        .flatMap((entry) => {
          const target = join(
            entry.root,
            specifier.slice(entry.name.length).replace(/^\//, ""),
          );
          if (target === null) return [];
          for (
            let parent = target;
            parent !== entry.root;
            parent = dir(parent)
          ) {
            if (!under(parent, entry.root) || paths.has(`${parent}/go.mod`))
              return [];
          }
          return packageFiles(target, [".go"]).filter(
            (path) =>
              !path.endsWith("_test.go") &&
              !path.split("/").at(-1)?.startsWith("_"),
          );
        }),
    );
  }

  if (language === "rust") {
    const parts = specifier
      .replace(/^::/, "")
      .replace(/\s*::\s*/g, "::")
      .replace(/::\*$/, "")
      .split("::")
      .map((part) => part.replace(/^r#/, ""));
    if (
      parts.some((part) => !/^[A-Za-z_]\w*$/.test(part)) ||
      ["std", "core", "alloc", "proc_macro", "test"].includes(parts[0])
    )
      return [];
    const manifest = closest(["Cargo.toml"]);
    const crateRoot = manifest
      ? (join(dir(manifest), "src") ?? "src")
      : (join(inferredRoot(), "src") ?? "src");
    const name = source.split("/").at(-1) ?? "";
    const current = ["lib.rs", "main.rs", "mod.rs"].includes(name)
      ? dir(source)
      : source.replace(/\.rs$/, "");
    let base = kind === "rust-mod" ? current : crateRoot;
    if (parts[0] === "crate") parts.shift();
    else if (parts[0] === "self") {
      base = current;
      parts.shift();
    } else if (parts[0] === "super") {
      base = current;
      while (parts[0] === "super") {
        parts.shift();
        base = dir(base);
      }
      if (base !== crateRoot && !under(base, crateRoot)) return [];
    } else if (kind !== "rust-mod" && manifest) {
      const packageName = (await read(manifest))
        ?.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1]
        .replace(/-/g, "_");
      if (parts[0] === packageName) parts.shift();
    }
    for (let count = parts.length; count >= (parts.length ? 1 : 0); count--) {
      const stem = join(base, parts.slice(0, count).join("/"));
      if (stem === null) continue;
      const candidates =
        stem === crateRoot
          ? [join(stem, "lib.rs"), join(stem, "main.rs")]
          : [`${stem}.rs`, join(stem, "mod.rs")];
      const found = finish(candidates);
      if (found.length) return found;
    }
    return [];
  }

  if (language === "jvm") {
    const value = specifier.replace(/^static\s+/, "");
    if (
      !/^[A-Za-z_$][\w$]*(?:\.(?:[A-Za-z_$][\w$]*|\*))*$/.test(value) ||
      /^(java|javax|kotlin|android)\./.test(value)
    )
      return [];
    const root = projectRoot([
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "settings.gradle",
      "settings.gradle.kts",
    ]);
    const roots = new Set<string>();
    const sourceRoot = source.match(/^(.*?src\/[^/]+\/(?:java|kotlin))\//)?.[1];
    if (sourceRoot) roots.add(sourceRoot);
    for (const languageRoot of ["java", "kotlin"])
      for (const scope of [
        "main",
        "test",
        "androidTest",
        "testFixtures",
        "debug",
        "release",
      ]) {
        const candidate = join(root, `src/${scope}/${languageRoot}`);
        if (candidate !== null) roots.add(candidate);
      }
    roots.add(join(root, "src") ?? root);
    roots.add(root);
    const parts = value.split(".");
    if (parts.at(-1) === "*")
      return finish(
        [...roots].flatMap((base) =>
          packageFiles(join(base, parts.slice(0, -1).join("/")), [
            ".java",
            ".kt",
          ]),
        ),
      );
    for (let count = parts.length; count > 0; count--) {
      const tail = parts.slice(0, count);
      const direct = finish(
        [...roots].flatMap((base) => {
          const path = join(base, tail.join("/"));
          return path === null ? [] : [`${path}.java`, `${path}.kt`];
        }),
      );
      if (direct.length) return direct;
      if (count < 2) continue;
      const namespace = tail.slice(0, -1).join(".");
      const symbol = tail.at(-1) ?? "";
      const candidates = [...roots].flatMap((base) =>
        packageFiles(join(base, tail.slice(0, -1).join("/")), [".java", ".kt"]),
      );
      const proven = await prove(
        candidates,
        (text) =>
          new RegExp(`\\bpackage\\s+${escapeRegex(namespace)}(?:\\s|;)`).test(
            text,
          ) &&
          new RegExp(
            `\\b(?:class|interface|object|enum|record|typealias|fun)\\s+${escapeRegex(symbol)}\\b`,
          ).test(text),
      );
      if (proven.length) return proven;
    }
    return [];
  }

  if (language === "c") {
    const root = projectRoot(["CMakeLists.txt", "meson.build", "Makefile"]);
    if (kind === "c-module") {
      if (
        !/^[A-Za-z_]\w*(?:[.:][A-Za-z_]\w*)*$/.test(specifier) ||
        /^std(?:[.:]|$)/.test(specifier)
      )
        return [];
      return prove(
        packageFiles(
          root,
          [".cppm", ".ixx", ".mpp", ".mxx", ".cpp", ".cc", ".cxx"],
          true,
        ),
        (text) =>
          new RegExp(
            `(?:^|[;}]|\\n)\\s*(?:export\\s+)?module\\s+${escapeRegex(specifier)}\\s*;`,
          ).test(text),
      );
    }
    if (
      specifier.startsWith("/") ||
      specifier.includes("\\") ||
      /^[\w+.-]+:/.test(specifier)
    )
      return [];
    if (kind !== "c-include-system") {
      const relative = join(dir(source), specifier);
      if (relative === null) return [];
      const direct = finish([relative]);
      if (direct.length) return direct;
    } else if (C_SYSTEM.has(specifier)) return [];
    return finish(
      ["include", "includes", "inc", "headers", "", "src"].map((folder) => {
        const base = join(root, folder);
        return base === null ? null : join(base, specifier);
      }),
    );
  }

  if (language === "csharp") {
    const name = specifier.replace(/^global::/, "");
    if (
      !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(name) ||
      /^System(?:\.|$)/.test(name)
    )
      return [];
    const project = closestSuffix(".csproj");
    const root = project ? dir(project) : inferredRoot();
    const rootNamespace = project
      ? (await read(project))?.match(
          /<RootNamespace>\s*([^<]+?)\s*<\/RootNamespace>/,
        )?.[1]
      : undefined;
    const relativeName =
      rootNamespace && name.startsWith(`${rootNamespace}.`)
        ? name.slice(rootNamespace.length + 1)
        : name;
    const expected = join(root, `${relativeName.replace(/\./g, "/")}.cs`);
    const namespaceFolder = dir(expected ?? "");
    const typeFile = `${name.split(".").at(-1)}.cs`;
    const nestedProjects = new Set(
      files.filter((path) => path.endsWith(".csproj")).map(dir),
    );
    const candidates = packageFiles(root, [".cs"], true)
      .filter((path) => {
        for (let parent = dir(path); parent !== root; parent = dir(parent)) {
          if (!under(parent, root) || nestedProjects.has(parent)) return false;
        }
        return true;
      })
      .sort(
        (a, b) =>
          Number(b === expected) - Number(a === expected) ||
          Number(b.split("/").at(-1) === typeFile) -
            Number(a.split("/").at(-1) === typeFile) ||
          Number(dir(b) === namespaceFolder) -
            Number(dir(a) === namespaceFolder) ||
          a.localeCompare(b),
      );
    return prove(candidates, (text) => {
      const namespaces = [
        ...text.matchAll(
          /\bnamespace\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*[;{]/g,
        ),
      ].map((match) => match[1]);
      const types = [
        ...text.matchAll(
          /\b(?:class|struct|interface|record|enum)\s+(?:(?:class|struct)\s+)?([A-Za-z_]\w*)/g,
        ),
      ].map((match) => match[1]);
      return namespaces.some(
        (namespace) =>
          namespace === name ||
          namespace.startsWith(`${name}.`) ||
          types.some((type) => `${namespace}.${type}` === name),
      );
    });
  }

  if (language === "php") {
    if (kind === "php-include") return finish([join(dir(source), specifier)]);
    const name = specifier.replace(/^\\/, "");
    if (!/^[A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*$/.test(name)) return [];
    const composer = closest(["composer.json"]);
    if (!composer) return [];
    let body: Record<string, unknown>;
    try {
      body = JSON.parse((await read(composer)) ?? "null");
    } catch {
      return [];
    }
    if (!body || typeof body !== "object") return [];
    const mappings: [string, string[]][] = [];
    for (const section of ["autoload", "autoload-dev"]) {
      const options = body[section] as Record<string, unknown> | undefined;
      const psr = options?.["psr-4"];
      if (!psr || typeof psr !== "object" || Array.isArray(psr)) continue;
      for (const [prefix, target] of Object.entries(psr)) {
        const targets =
          typeof target === "string"
            ? [target]
            : Array.isArray(target)
              ? target.filter(
                  (entry): entry is string => typeof entry === "string",
                )
              : [];
        if (name.startsWith(prefix))
          mappings.push([prefix, targets.slice(0, MAX_CANDIDATES)]);
      }
    }
    mappings.sort(([a], [b]) => b.length - a.length);
    for (const [prefix, targets] of mappings) {
      const suffix = `${name.slice(prefix.length).replace(/\\/g, "/")}.php`;
      const candidates = finish(
        targets.map((target) => {
          const base = join(dir(composer), target);
          return base === null ? null : join(base, suffix);
        }),
      );
      if (candidates.length) return candidates;
    }
    return [];
  }

  if (language === "ruby") {
    if (
      specifier.startsWith("/") ||
      specifier.includes("\\") ||
      /^[\w+.-]+:/.test(specifier)
    )
      return [];
    if (kind !== "ruby-require-relative" && RUBY_BUILTINS.has(specifier))
      return [];
    const manifest = closest(["Gemfile"]) ?? closestSuffix(".gemspec");
    const root = manifest ? dir(manifest) : inferredRoot();
    const bases =
      kind === "ruby-require-relative"
        ? [dir(source)]
        : [join(root, "lib") ?? root, root];
    for (const base of bases) {
      const path = join(base, specifier);
      if (path === null) return [];
      const candidates = finish([
        path,
        path.endsWith(".rb") ? null : `${path}.rb`,
      ]);
      if (candidates.length) return candidates;
    }
    return [];
  }

  if (language === "swift") {
    if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(specifier)) return [];
    const [module, ...symbols] = specifier.split(".");
    if (SWIFT_BUILTINS.has(module)) return [];
    const root = projectRoot(["Package.swift"]);
    const base = join(root, `Sources/${module}`);
    const candidates = packageFiles(base, [".swift"], true);
    if (!symbols.length) return finish(candidates);
    const symbol = symbols[0];
    const direct = finish(base === null ? [] : [join(base, `${symbol}.swift`)]);
    if (direct.length) return direct;
    return prove(candidates, (text) =>
      new RegExp(
        `\\b(?:class|struct|enum|protocol|typealias|func|actor)\\s+${escapeRegex(symbol)}\\b`,
      ).test(text),
    );
  }

  if (language === "dart") {
    if (specifier.startsWith("package:")) {
      const match = specifier.match(/^package:([A-Za-z_]\w*)\/(.+)$/);
      const pubspec = closest(["pubspec.yaml"]);
      if (!match || !pubspec) return [];
      const name = (await read(pubspec))?.match(
        /^\s*name:\s*["']?([A-Za-z_]\w*)/m,
      )?.[1];
      if (name !== match[1]) return [];
      const root = join(dir(pubspec), "lib");
      const target = root === null ? null : join(root, match[2]);
      return target !== null && root !== null && under(target, root)
        ? finish([target])
        : [];
    }
    if (specifier.startsWith("/") || /^[\w+.-]+:/.test(specifier)) return [];
    return finish([join(dir(source), specifier)]);
  }
  return [];
}

import { languageForPath } from "./code-import-languages";
import { resolvePrImport } from "./pr-import-resolution";
