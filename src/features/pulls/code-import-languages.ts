import { scanPrCodeImports } from "./pr-code-imports";

export type CodeImportLanguage =
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "jvm"
  | "c"
  | "csharp"
  | "php"
  | "ruby"
  | "swift"
  | "dart";
export type CodeImport = {
  from: number;
  to: number;
  specifier: string;
  kind?: string;
};
const MAX_CHARS = 400_000;
const MAX_IMPORTS = 1_000;
const EXTENSIONS: Record<CodeImportLanguage, ReadonlySet<string>> = {
  javascript: new Set([
    "js",
    "jsx",
    "mjs",
    "cjs",
    "ts",
    "tsx",
    "mts",
    "cts",
    "vue",
    "svelte",
    "astro",
  ]),
  python: new Set(["py", "pyi"]),
  go: new Set(["go"]),
  rust: new Set(["rs"]),
  jvm: new Set(["java", "kt", "kts"]),
  c: new Set([
    "c",
    "h",
    "cc",
    "hh",
    "cpp",
    "hpp",
    "cxx",
    "hxx",
    "m",
    "mm",
    "ixx",
    "cppm",
  ]),
  csharp: new Set(["cs", "csx"]),
  php: new Set(["php", "phtml"]),
  ruby: new Set(["rb", "rake"]),
  swift: new Set(["swift"]),
  dart: new Set(["dart"]),
};
const extension = (path: string) => {
  const name = path.slice(
    Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1,
  );
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
};

export function languageForPath(path: string): CodeImportLanguage | null {
  const ext = extension(path);
  for (const language of Object.keys(EXTENSIONS) as CodeImportLanguage[])
    if (EXTENSIONS[language].has(ext)) return language;
  return null;
}
export function supportsCodeImports(path: string): boolean {
  return languageForPath(path) !== null;
}
type Token = {
  value: string;
  from: number;
  to: number;
  kind: "word" | "string" | "punct" | "newline";
  literal?: boolean;
  quote?: string;
};
const identifierStart = /[\p{ID_Start}_$]/u;
const identifierPart = /[\p{ID_Continue}_$]/u;
const wordIs = (token: Token | undefined, value: string) =>
  token?.kind === "word" && token.value === value;
const wordIn = (token: Token | undefined, values: readonly string[]) =>
  token?.kind === "word" && values.includes(token.value);
function cleanPath(value: string): boolean {
  if (value === "" || value.length > 4_000) return false;
  for (let at = 0; at < value.length; at++)
    if (value.charCodeAt(at) < 32 || value.charCodeAt(at) === 127) return false;
  return true;
}

function decodeLiteral(
  raw: string,
  quote: string,
  language: CodeImportLanguage,
  verbatim: boolean,
): string | null {
  if (!cleanPath(raw)) return null;
  if (
    !verbatim &&
    ((language === "php" && quote === '"' && raw.includes("$")) ||
      (language === "ruby" && quote === '"' && raw.includes("#{")) ||
      (language === "dart" && raw.includes("$")) ||
      (language === "swift" && raw.includes("\\(")))
  )
    return null;
  if (verbatim || language === "c") return raw;
  let out = "";
  for (let at = 0; at < raw.length; at++) {
    if (raw[at] !== "\\") out += raw[at];
    else {
      const next = raw[++at];
      if (next === "\\" || next === quote || next === "/") out += next;
      else if (language === "php" && quote === "'") out += `\\${next}`;
      else return null;
    }
  }
  return cleanPath(out) ? out : null;
}

function heredocEnd(
  source: string,
  at: number,
  language: CodeImportLanguage,
): number | null {
  const start = source
    .slice(at)
    .match(
      language === "php"
        ? /^<<<[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))/
        : /^<<[-~]?(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))/,
    );
  if (!start) return null;
  const label = start[1] ?? start[2] ?? start[3];
  let line = source.indexOf("\n", at + start[0].length);
  while (line >= 0 && line < source.length) {
    const end = source.indexOf("\n", line + 1);
    const value = source.slice(line + 1, end < 0 ? source.length : end).trim();
    if (value === label || value === `${label};`)
      return end < 0 ? source.length : end;
    line = end;
  }
  return source.length;
}

function tokensFor(source: string, language: CodeImportLanguage): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  let php = language !== "php";
  const opaque = (end: number) => {
    tokens.push({
      kind: "string",
      value: "",
      from: at,
      to: end,
      literal: false,
    });
    at = end;
  };
  while (at < source.length && tokens.length < 150_000) {
    const char = source[at];
    // Ruby document comments and DATA markers are recognized only at column 0.
    // Skipping here leaves marker-like text inside strings/heredocs untouched.
    if (language === "ruby" && (at === 0 || source[at - 1] === "\n")) {
      if (/^__END__(?:\r?\n|$)/.test(source.slice(at))) break;
      if (/^=begin(?:\s|$)/.test(source.slice(at))) {
        let line = source.indexOf("\n", at);
        at = source.length;
        while (line >= 0) {
          const start = line + 1;
          if (/^=end(?:\s|$)/.test(source.slice(start))) {
            const end = source.indexOf("\n", start);
            at = end < 0 ? source.length : end;
            break;
          }
          line = source.indexOf("\n", start);
        }
        continue;
      }
    }
    if (!php) {
      const open = /<\?(?:php\b|=)/gi;
      open.lastIndex = at;
      const match = open.exec(source);
      if (!match) break;
      at = match.index + match[0].length;
      php = true;
      continue;
    }
    if (language === "php" && source.startsWith("?>", at)) {
      php = false;
      at += 2;
      continue;
    }
    if (char === "\n" || char === "\r") {
      const end = char === "\r" && source[at + 1] === "\n" ? at + 2 : at + 1;
      tokens.push({ kind: "newline", value: "\n", from: at, to: end });
      at = end;
      continue;
    }
    if (/\s/.test(char)) {
      at++;
      continue;
    }
    if (
      (language === "python" || language === "c") &&
      char === "\\" &&
      (source[at + 1] === "\n" || source.startsWith("\r\n", at + 1))
    ) {
      at += source[at + 1] === "\r" ? 3 : 2;
      continue;
    }
    const hashComment =
      ["python", "ruby", "php"].includes(language) && char === "#";
    if (
      hashComment ||
      (!["python", "ruby"].includes(language) && source.startsWith("//", at))
    ) {
      let end = source.indexOf("\n", at + 1);
      while (
        language === "c" &&
        end > 0 &&
        (source[end - 1] === "\\" ||
          (source[end - 1] === "\r" && source[end - 2] === "\\"))
      )
        end = source.indexOf("\n", end + 1);
      at = end < 0 ? source.length : end;
      continue;
    }
    if (language === "ruby" || language === "swift") {
      const hashes =
        language === "swift"
          ? (source.slice(at).match(/^(#+)\//)?.[1] ?? "")
          : "";
      const previous = tokens.at(-1);
      const regular =
        char === "/" &&
        (!previous ||
          previous.kind === "newline" ||
          ["=", "(", "[", "{", ",", ":", "return", "=>", ";"].includes(
            previous.value,
          ));
      if (hashes || (regular && !source.startsWith("/*", at))) {
        let end = at + hashes.length + 1;
        let bracket = false;
        const closing = `/${hashes}`;
        while (end < source.length) {
          if (source[end] === "\\") end += 2;
          else if (!bracket && source.startsWith(closing, end)) {
            end += closing.length;
            break;
          } else {
            if (source[end] === "[") bracket = true;
            if (source[end] === "]") bracket = false;
            end++;
          }
        }
        opaque(end);
        continue;
      }
    }
    if (source.startsWith("/*", at)) {
      let depth = 1;
      at += 2;
      while (at < source.length && depth > 0) {
        if (
          source.startsWith("/*", at) &&
          ["rust", "jvm", "swift"].includes(language)
        ) {
          depth++;
          at += 2;
        } else if (source.startsWith("*/", at)) {
          depth--;
          at += 2;
        } else {
          if (source[at] === "\n")
            tokens.push({ kind: "newline", value: "\n", from: at, to: at + 1 });
          at++;
        }
      }
      continue;
    }
    if (
      (language === "php" && source.startsWith("<<<", at)) ||
      (language === "ruby" && source.startsWith("<<", at))
    ) {
      const end = heredocEnd(source, at, language);
      if (end !== null) {
        opaque(end);
        continue;
      }
    }
    if (language === "c") {
      const raw = source.slice(at).match(/^(?:u8|u|U|L)?R"([^\s()\\]{0,16})\(/);
      if (raw) {
        const end = source.indexOf(`)${raw[1]}"`, at + raw[0].length);
        opaque(end < 0 ? source.length : end + raw[1].length + 2);
        continue;
      }
    }
    if (language === "rust") {
      const raw = source.slice(at).match(/^(?:br|r)(#{0,64})"/);
      if (raw) {
        const close = `"${raw[1]}`;
        const end = source.indexOf(close, at + raw[0].length);
        opaque(end < 0 ? source.length : end + close.length);
        continue;
      }
      const rawIdentifier = source
        .slice(at)
        .match(/^r#([\p{ID_Start}_][\p{ID_Continue}_]*)/u);
      if (rawIdentifier) {
        tokens.push({
          kind: "word",
          value: rawIdentifier[1],
          from: at,
          to: at + rawIdentifier[0].length,
        });
        at += rawIdentifier[0].length;
        continue;
      }
      if (
        char === "'" &&
        /^'[\p{ID_Start}_][\p{ID_Continue}_]*(?!')/u.test(source.slice(at)) &&
        !/^'[^'\r\n]'/.test(source.slice(at))
      ) {
        tokens.push({ kind: "punct", value: "'", from: at, to: at + 1 });
        at++;
        continue;
      }
    }
    if (
      language === "ruby" &&
      source[at] === "%" &&
      /^[qQrwWxsiI]?[^\w\s]/.test(source.slice(at + 1))
    ) {
      let delimiterAt = at + 1;
      if (/[qQrwWxsiI]/.test(source[delimiterAt])) delimiterAt++;
      const open = source[delimiterAt];
      const close =
        ({ "(": ")", "[": "]", "{": "}", "<": ">" } as Record<string, string>)[
          open
        ] ?? open;
      let end = delimiterAt + 1;
      let depth = 1;
      while (end < source.length && depth > 0) {
        if (source[end] === "\\") end += 2;
        else {
          if (open !== close && source[end] === open) depth++;
          if (source[end] === close) depth--;
          end++;
        }
      }
      opaque(end);
      continue;
    }
    let quoteAt = at;
    let verbatim = false;
    let hashes = "";
    if (language === "python") {
      const prefix = source.slice(at).match(/^[rRuUbBfF]{1,3}(?=['"])/);
      if (prefix) quoteAt += prefix[0].length;
    }
    if (
      language === "dart" &&
      /[rR]/.test(char) &&
      /['"]/.test(source[at + 1] ?? "")
    ) {
      quoteAt++;
      verbatim = true;
    }
    if (language === "csharp") {
      const prefix = source.slice(at).match(/^(?:\$@|@\$|\$|@)(?=")/);
      if (prefix) {
        quoteAt += prefix[0].length;
        verbatim = prefix[0].includes("@");
      }
    }
    if (language === "swift") {
      const prefix = source.slice(at).match(/^#+(?=")/);
      if (prefix) {
        hashes = prefix[0];
        quoteAt += hashes.length;
        verbatim = true;
      }
    }
    const quote = source[quoteAt];
    if (quote === "'" || quote === '"' || quote === "`") {
      const triple =
        quote !== "`" && source.startsWith(quote.repeat(3), quoteAt);
      const width =
        triple && language === "csharp"
          ? (source.slice(quoteAt).match(/^"+/)?.[0].length ?? 3)
          : triple
            ? 3
            : 1;
      const closing = quote.repeat(width) + hashes;
      let end = quoteAt + width;
      while (end < source.length) {
        if (source.startsWith(closing, end)) {
          if (
            language === "csharp" &&
            verbatim &&
            !triple &&
            source[end + 1] === '"'
          ) {
            end += 2;
            continue;
          }
          break;
        }
        if (source[end] === "\\" && !verbatim && quote !== "`") end += 2;
        else end++;
      }
      const raw = source.slice(quoteAt + width, end);
      const literal =
        !triple &&
        hashes === "" &&
        (quote !== "`" || language === "go") &&
        end < source.length;
      const value = literal
        ? decodeLiteral(raw, quote, language, verbatim || quote === "`")
        : null;
      tokens.push({
        kind: "string",
        value: value ?? "",
        from: quoteAt + width,
        to: end,
        literal: value !== null,
        quote,
      });
      at = Math.min(source.length, end + closing.length);
      continue;
    }
    if (identifierStart.test(char)) {
      const from = at++;
      while (at < source.length && identifierPart.test(source[at])) at++;
      tokens.push({
        kind: "word",
        value: source.slice(from, at),
        from,
        to: at,
      });
      continue;
    }
    const pair = source.slice(at, at + 2);
    const value = ["::", "->", "=>"].includes(pair) ? pair : char;
    tokens.push({ kind: "punct", value, from: at, to: at + value.length });
    at += value.length;
  }
  return tokens;
}

type PathRead = {
  value: string;
  from: number;
  to: number;
  last: Token;
  next: number;
};
function skipLines(tokens: Token[], index: number): number {
  while (
    tokens[index]?.kind === "newline" ||
    (tokens[index]?.value === "\\" && tokens[index + 1]?.kind === "newline")
  )
    index += tokens[index]?.value === "\\" ? 2 : 1;
  return index;
}
function readPath(
  tokens: Token[],
  index: number,
  separators: string[],
  leading = false,
  wildcard = false,
): PathRead | null {
  const start = tokens[index];
  let value = "";
  let last = start;
  if (leading)
    while (separators.includes(tokens[index]?.value))
      value += tokens[index++].value;
  if (
    tokens[index]?.kind !== "word" &&
    !(wildcard && tokens[index]?.value === "*")
  )
    return value && start
      ? {
          value,
          from: start.from,
          to: tokens[index - 1].to,
          last: tokens[index - 1],
          next: index,
        }
      : null;
  last = tokens[index];
  value += last.value;
  index++;
  while (
    separators.includes(tokens[index]?.value) &&
    (tokens[index + 1]?.kind === "word" ||
      (wildcard && tokens[index + 1]?.value === "*"))
  ) {
    value += tokens[index++].value;
    last = tokens[index++];
    value += last.value;
  }
  return { value, from: start.from, to: last.to, last, next: index };
}
function entry(
  token: Pick<Token, "from" | "to">,
  specifier: string,
  kind?: string,
): CodeImport {
  return {
    from: token.from,
    to: token.to,
    specifier,
    ...(kind ? { kind } : {}),
  };
}
const literalEntry = (
  token: Token | undefined,
  kind?: string,
): CodeImport | null =>
  token?.kind === "string" && token.literal
    ? entry(token, token.value, kind)
    : null;

function pythonImports(tokens: Token[]): CodeImport[] {
  const out: CodeImport[] = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].kind !== "word") continue;
    const mode = tokens[index].value;
    if (mode !== "import" && mode !== "from") continue;
    let cursor = index + 1;
    let module: PathRead | null = null;
    if (mode === "from") {
      let dots = cursor;
      while (tokens[dots]?.value === ".") dots++;
      module =
        dots > cursor && wordIs(tokens[dots], "import")
          ? {
              value: ".".repeat(dots - cursor),
              from: tokens[cursor].from,
              to: tokens[dots - 1].to,
              last: tokens[dots - 1],
              next: dots,
            }
          : readPath(tokens, cursor, ["."], true);
      if (!module || !wordIs(tokens[module.next], "import")) continue;
      cursor = module.next + 1;
    }
    const paren = mode === "from" && tokens[cursor]?.value === "(";
    if (paren) cursor++;
    const pending: CodeImport[] = [];
    if (module) pending.push(entry(module, module.value));
    let members = 0;
    let valid = false;
    while (cursor < tokens.length) {
      if (paren) cursor = skipLines(tokens, cursor);
      if (module && tokens[cursor]?.value === "*") {
        members++;
        cursor++;
      } else {
        const name = readPath(tokens, cursor, mode === "import" ? ["."] : []);
        if (!name) break;
        const separator = module?.value.endsWith(".") ? "" : ".";
        pending.push(
          entry(
            name,
            module ? `${module.value}${separator}${name.value}` : name.value,
          ),
        );
        members++;
        cursor = name.next;
        if (wordIs(tokens[cursor], "as") && tokens[cursor + 1]?.kind === "word")
          cursor += 2;
      }
      if (paren) cursor = skipLines(tokens, cursor);
      if (tokens[cursor]?.value === ",") {
        cursor++;
        if (paren && tokens[skipLines(tokens, cursor)]?.value === ")") {
          cursor = skipLines(tokens, cursor);
          valid = true;
          break;
        }
        continue;
      }
      valid = paren
        ? tokens[cursor]?.value === ")"
        : !tokens[cursor] ||
          tokens[cursor].kind === "newline" ||
          tokens[cursor].value === ";";
      break;
    }
    if (valid && members > 0) {
      out.push(...pending);
      index = cursor - (paren ? 0 : 1);
    }
  }
  return out;
}

function goImports(tokens: Token[]): CodeImport[] {
  const out: CodeImport[] = [];
  for (let index = 0; index < tokens.length; index++) {
    if (!wordIs(tokens[index], "import")) continue;
    let cursor = skipLines(tokens, index + 1);
    const group = tokens[cursor]?.value === "(";
    if (group) cursor++;
    const pending: CodeImport[] = [];
    let valid = false;
    do {
      cursor = skipLines(tokens, cursor);
      while (tokens[cursor]?.value === ";")
        cursor = skipLines(tokens, cursor + 1);
      if (group && tokens[cursor]?.value === ")") {
        valid = true;
        break;
      }
      if (tokens[cursor]?.kind === "word" || tokens[cursor]?.value === ".")
        cursor++;
      const item = ['"', "`"].includes(tokens[cursor]?.quote ?? "")
        ? literalEntry(tokens[cursor])
        : null;
      if (!item) break;
      pending.push(item);
      cursor++;
      if (!group) {
        valid =
          !tokens[cursor] ||
          tokens[cursor].kind === "newline" ||
          tokens[cursor].value === ";";
        break;
      }
      if (
        tokens[cursor]?.kind !== "newline" &&
        tokens[cursor]?.value !== ";" &&
        tokens[cursor]?.value !== ")"
      )
        break;
    } while (cursor < tokens.length);
    if (valid) out.push(...pending);
  }
  return out;
}

function rustImports(tokens: Token[]): CodeImport[] {
  const out: CodeImport[] = [];
  const tree = (
    start: number,
    prefix: string[],
    depth: number,
  ): { next: number; items: CodeImport[] } | null => {
    if (depth > 32) return null;
    let cursor = skipLines(tokens, start);
    const parts = [...prefix];
    if (tokens[cursor]?.value === "::") {
      parts.push("");
      cursor++;
    }
    let last: Token | undefined;
    while (tokens[cursor]?.kind === "word") {
      last = tokens[cursor++];
      parts.push(last.value);
      if (tokens[cursor]?.value !== "::") break;
      cursor = skipLines(tokens, cursor + 1);
    }
    if (tokens[cursor]?.value === "{") {
      cursor++;
      const items: CodeImport[] = [];
      while (cursor < tokens.length) {
        cursor = skipLines(tokens, cursor);
        if (tokens[cursor]?.value === "}") return { next: cursor + 1, items };
        const child = tree(cursor, parts, depth + 1);
        if (!child) return null;
        items.push(...child.items);
        cursor = skipLines(tokens, child.next);
        if (tokens[cursor]?.value === ",") cursor++;
        else if (tokens[cursor]?.value !== "}") return null;
      }
      return null;
    }
    if (tokens[cursor]?.value === "*") {
      last = tokens[cursor++];
    } else if (parts.at(-1) === "self" && parts.length > 1) parts.pop();
    if (!last || parts.length === 0) return null;
    if (wordIs(tokens[cursor], "as") && tokens[cursor + 1]?.kind === "word")
      cursor += 2;
    return { next: cursor, items: [entry(last, parts.join("::"), "rust-use")] };
  };
  for (let index = 0; index < tokens.length; index++) {
    if (wordIs(tokens[index], "use")) {
      const result = tree(index + 1, [], 0);
      if (result && tokens[skipLines(tokens, result.next)]?.value === ";")
        out.push(...result.items);
    } else if (
      wordIs(tokens[index], "mod") &&
      tokens[index + 1]?.kind === "word" &&
      tokens[index + 2]?.value === ";"
    )
      out.push(entry(tokens[index + 1], tokens[index + 1].value, "rust-mod"));
  }
  return out;
}

function namespaceImports(
  tokens: Token[],
  language: "jvm" | "csharp" | "swift",
): CodeImport[] {
  const out: CodeImport[] = [];
  const keyword = language === "csharp" ? "using" : "import";
  for (let index = 0; index < tokens.length; index++) {
    if (
      !wordIs(tokens[index], keyword) ||
      [".", "::"].includes(tokens[index - 1]?.value)
    )
      continue;
    let cursor = index + 1;
    if (
      wordIs(tokens[cursor], "static") ||
      (language === "swift" &&
        wordIn(tokens[cursor], [
          "typealias",
          "struct",
          "class",
          "enum",
          "protocol",
          "let",
          "var",
          "func",
        ]))
    )
      cursor++;
    let name = readPath(
      tokens,
      cursor,
      language === "csharp" ? [".", "::"] : ["."],
      false,
      language === "jvm",
    );
    if (!name) continue;
    cursor = name.next;
    if (language === "csharp" && tokens[cursor]?.value === "=") {
      name = readPath(tokens, cursor + 1, [".", "::"]);
      if (!name) continue;
      cursor = name.next;
    }
    if (
      language === "jvm" &&
      wordIs(tokens[cursor], "as") &&
      tokens[cursor + 1]?.kind === "word"
    )
      cursor += 2;
    const terminal = tokens[cursor];
    if (
      terminal?.value !== ";" &&
      (language === "csharp" || (terminal && terminal.kind !== "newline"))
    )
      continue;
    out.push(entry(name, name.value.replace(/^global::/, "")));
  }
  return out;
}

function cImports(tokens: Token[], path: string): CodeImport[] {
  const out: CodeImport[] = [];
  const headers = (cursor: number): CodeImport | null => {
    const quoted =
      tokens[cursor]?.quote === '"'
        ? literalEntry(tokens[cursor], "c-include-quoted")
        : null;
    if (quoted) return quoted;
    if (tokens[cursor]?.value !== "<") return null;
    const first = tokens[cursor];
    cursor++;
    let value = "";
    while (
      tokens[cursor] &&
      tokens[cursor].kind !== "newline" &&
      tokens[cursor].value !== ">"
    )
      value += tokens[cursor++].value;
    return tokens[cursor]?.value === ">" && cleanPath(value)
      ? entry(
          { from: first.to, to: tokens[cursor].from },
          value,
          "c-include-system",
        )
      : null;
  };
  for (let index = 0; index < tokens.length; index++) {
    if (
      tokens[index].kind === "punct" &&
      tokens[index].value === "#" &&
      wordIn(tokens[index + 1], ["include", "import"]) &&
      (index === 0 || tokens[index - 1].kind === "newline")
    ) {
      const item = headers(index + 2);
      if (item) out.push(item);
    } else if (
      wordIs(tokens[index], "import") &&
      ["cc", "hh", "cpp", "hpp", "cxx", "hxx", "ixx", "cppm"].includes(
        extension(path),
      ) &&
      (index === 0 || [";", "export", "\n"].includes(tokens[index - 1].value))
    ) {
      const header = headers(index + 1);
      if (header) {
        out.push(header);
        continue;
      }
      const name = readPath(tokens, index + 1, [".", ":"]);
      if (name && tokens[name.next]?.value === ";")
        out.push(entry(name, name.value, "c-module"));
    }
  }
  return out;
}

function phpImports(tokens: Token[]): CodeImport[] {
  const out: CodeImport[] = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].kind !== "word") continue;
    const value = tokens[index].value;
    if (
      ["include", "include_once", "require", "require_once"].includes(value) &&
      !["->", "::", "\\"].includes(tokens[index - 1]?.value)
    ) {
      let cursor = index + 1;
      const paren = tokens[cursor]?.value === "(";
      if (paren) cursor++;
      let directory = false;
      if (
        wordIs(tokens[cursor], "__DIR__") &&
        tokens[cursor + 1]?.value === "."
      ) {
        directory = true;
        cursor += 2;
      }
      const item = literalEntry(tokens[cursor], "php-include");
      if (!item) continue;
      cursor++;
      if (paren) {
        if (tokens[cursor]?.value !== ")") continue;
        cursor++;
      }
      if (
        tokens[cursor] &&
        tokens[cursor].kind !== "newline" &&
        ![";", ")", ","].includes(tokens[cursor].value)
      )
        continue;
      out.push(
        directory
          ? { ...item, specifier: `./${item.specifier.replace(/^\/+/, "")}` }
          : item,
      );
    } else if (value === "use") {
      let cursor = index + 1;
      if (wordIn(tokens[cursor], ["function", "const"])) cursor++;
      const pending: CodeImport[] = [];
      let valid = false;
      while (cursor < tokens.length) {
        const name = readPath(tokens, cursor, ["\\"], true);
        if (!name) break;
        cursor = name.next;
        if (
          tokens[cursor]?.value === "\\" &&
          tokens[cursor + 1]?.value === "{"
        ) {
          cursor += 2;
          while (cursor < tokens.length) {
            cursor = skipLines(tokens, cursor);
            if (wordIn(tokens[cursor], ["function", "const"])) cursor++;
            const member = readPath(tokens, cursor, ["\\"]);
            if (!member) break;
            pending.push(
              entry(member.last, `${name.value}\\${member.value}`, "php-use"),
            );
            cursor = member.next;
            if (
              wordIs(tokens[cursor], "as") &&
              tokens[cursor + 1]?.kind === "word"
            )
              cursor += 2;
            cursor = skipLines(tokens, cursor);
            if (tokens[cursor]?.value === ",") {
              cursor++;
              continue;
            }
            if (tokens[cursor]?.value === "}") {
              cursor++;
              valid = tokens[cursor]?.value === ";";
            }
            break;
          }
          break;
        }
        pending.push(entry(name, name.value, "php-use"));
        if (wordIs(tokens[cursor], "as") && tokens[cursor + 1]?.kind === "word")
          cursor += 2;
        if (tokens[cursor]?.value === ",") {
          cursor++;
          continue;
        }
        valid = tokens[cursor]?.value === ";";
        break;
      }
      if (valid) out.push(...pending);
    }
  }
  return out;
}

function rubyImports(tokens: Token[]): CodeImport[] {
  const out: CodeImport[] = [];
  for (let index = 0; index < tokens.length; index++) {
    if (!wordIn(tokens[index], ["require", "require_relative"])) continue;
    if (
      [".", "::"].includes(tokens[index - 1]?.value) &&
      !wordIs(tokens[index - 2], "Kernel")
    )
      continue;
    let cursor = index + 1;
    const paren = tokens[cursor]?.value === "(";
    if (paren) cursor = skipLines(tokens, cursor + 1);
    const item = literalEntry(
      tokens[cursor],
      tokens[index].value === "require_relative"
        ? "ruby-require-relative"
        : "ruby-require",
    );
    if (!item) continue;
    cursor++;
    if (paren) {
      cursor = skipLines(tokens, cursor);
      if (tokens[cursor]?.value !== ")") continue;
      cursor++;
    }
    if (
      tokens[cursor] &&
      tokens[cursor].kind !== "newline" &&
      !(
        tokens[cursor].kind === "punct" &&
        [";", ")", ","].includes(tokens[cursor].value)
      ) &&
      !wordIn(tokens[cursor], ["if", "unless"])
    )
      continue;
    out.push(item);
  }
  return out;
}

function dartImports(tokens: Token[]): CodeImport[] {
  const out: CodeImport[] = [];
  for (let index = 0; index < tokens.length; index++) {
    if (!wordIn(tokens[index], ["import", "export", "part"])) continue;
    let cursor = index + 1;
    if (wordIs(tokens[index], "part") && wordIs(tokens[cursor], "of")) cursor++;
    const first = literalEntry(tokens[cursor]);
    if (!first) continue;
    const pending = [first];
    cursor++;
    while (tokens[cursor] && tokens[cursor].value !== ";") {
      if (wordIs(tokens[cursor], "if") && tokens[cursor + 1]?.value === "(") {
        cursor += 2;
        let depth = 1;
        while (cursor < tokens.length && depth > 0) {
          if (tokens[cursor].value === "(") depth++;
          if (tokens[cursor].value === ")") depth--;
          cursor++;
        }
        const alternative = literalEntry(tokens[cursor]);
        if (!alternative) break;
        pending.push(alternative);
        cursor++;
      } else cursor++;
    }
    if (tokens[cursor]?.value === ";") out.push(...pending);
  }
  return out;
}

function skipMarkupExpression(source: string, start: number): number {
  let depth = 1;
  let at = start + 1;
  while (at < source.length && depth > 0) {
    const char = source[at];
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      at++;
      while (at < source.length) {
        if (source[at] === "\\") at += 2;
        else if (source[at++] === quote) break;
        else continue;
      }
    } else if (source.startsWith("/*", at)) {
      const end = source.indexOf("*/", at + 2);
      at = end < 0 ? source.length : end + 2;
    } else if (source.startsWith("//", at)) {
      const end = source.indexOf("\n", at + 2);
      at = end < 0 ? source.length : end;
    } else {
      if (char === "{") depth++;
      if (char === "}") depth--;
      at++;
    }
  }
  return at;
}

function scriptImports(source: string, path: string): CodeImport[] {
  const ext = extension(path);
  const scan = (text: string, offset: number, jsx = false) =>
    scanPrCodeImports(text, jsx).map((item) => ({
      ...item,
      from: item.from + offset,
      to: item.to + offset,
    }));
  if (ext === "astro") {
    const opening = source.match(/^\uFEFF?---[ \t]*\r?\n/);
    if (!opening) return [];
    const close = /^---[ \t]*(?:\r?\n|$)/gm;
    close.lastIndex = opening[0].length;
    const match = close.exec(source);
    return match
      ? scan(source.slice(opening[0].length, match.index), opening[0].length)
      : [];
  }
  if (ext !== "vue" && ext !== "svelte")
    return scan(source, 0, /\.[jt]sx$/i.test(path));
  const out: CodeImport[] = [];
  const stack: string[] = [];
  let at = 0;
  const voidTags = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
  ]);
  while (at < source.length) {
    if (source.startsWith("<!--", at)) {
      const end = source.indexOf("-->", at + 4);
      at = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source[at] === "{") {
      at = skipMarkupExpression(source, at);
      continue;
    }
    if (source[at] !== "<") {
      at++;
      continue;
    }
    const tag = source
      .slice(at)
      .match(/^<\s*(\/?)\s*([A-Za-z][\w:.-]*)\b((?:[^'">]|'[^']*'|"[^"]*")*)>/);
    if (!tag) {
      at++;
      continue;
    }
    const name = tag[2].toLowerCase();
    const end = at + tag[0].length;
    if (tag[1]) {
      if (stack.at(-1) === name) stack.pop();
      at = end;
      continue;
    }
    if (["script", "style", "textarea"].includes(name)) {
      const close = new RegExp(`</${name}\\s*>`, "ig");
      close.lastIndex = end;
      const match = close.exec(source);
      if (!match) break;
      if (name === "script" && stack.length === 0) {
        const attribute = (name: string) => {
          const match = new RegExp(
            `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`,
            "i",
          ).exec(tag[3]);
          return (match?.[1] ?? match?.[2] ?? match?.[3])?.toLowerCase();
        };
        const lang = attribute("lang");
        const type = attribute("type");
        if (
          !/(?:^|\s)src\s*=/i.test(tag[3]) &&
          (!lang ||
            ["js", "javascript", "ts", "typescript", "jsx", "tsx"].includes(
              lang,
            )) &&
          (!type ||
            [
              "module",
              "text/javascript",
              "application/javascript",
              "text/typescript",
            ].includes(type))
        )
          out.push(
            ...scan(
              source.slice(end, match.index),
              end,
              lang === "jsx" || lang === "tsx",
            ),
          );
      }
      at = match.index + match[0].length;
      continue;
    }
    if (!/\/\s*>$/.test(tag[0]) && !voidTags.has(name)) stack.push(name);
    at = end;
  }
  return out;
}

/** File-extension dispatch keeps each directive grammar separate. Tokens retain
 *  source offsets; only verified literal paths and module directives escape. */
export function scanCodeImports(source: string, path: string): CodeImport[] {
  if (source.length > MAX_CHARS) return [];
  const language = languageForPath(path);
  if (language === null) return [];
  let found: CodeImport[];
  if (language === "javascript") found = scriptImports(source, path);
  else {
    const tokens = tokensFor(source, language);
    switch (language) {
      case "python":
        found = pythonImports(tokens);
        break;
      case "go":
        found = goImports(tokens);
        break;
      case "rust":
        found = rustImports(tokens);
        break;
      case "jvm":
      case "csharp":
      case "swift":
        found = namespaceImports(tokens, language);
        break;
      case "c":
        found = cImports(tokens, path);
        break;
      case "php":
        found = phpImports(tokens);
        break;
      case "ruby":
        found = rubyImports(tokens);
        break;
      case "dart":
        found = dartImports(tokens);
        break;
    }
  }
  const out: CodeImport[] = [];
  let end = -1;
  for (const item of found.sort((a, b) => a.from - b.from)) {
    if (out.length >= MAX_IMPORTS) break;
    if (item.from < end || item.to <= item.from || !cleanPath(item.specifier))
      continue;
    out.push(item);
    end = item.to;
  }
  return out;
}
