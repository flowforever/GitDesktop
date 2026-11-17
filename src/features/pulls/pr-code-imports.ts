export interface PrCodeImport {
  /** UTF-16 offsets inside the string's quotes, suitable for DOM/CodeMirror. */
  from: number;
  to: number;
  specifier: string;
}

export const PR_CODE_IMPORT_MAX_CHARS = 400_000;
type Token = {
  kind: "word" | "string" | "punct";
  value: string;
  from: number;
  to: number;
};
const wordStart = /[\p{ID_Start}$_]/u;
const wordPart = /[\p{ID_Continue}$\u200c\u200d]/u;

function quotedEnd(source: string, start: number): number {
  const quote = source[start];
  for (let at = start + 1; at < source.length; at++) {
    if (source[at] === "\\") at++;
    else if (source[at] === quote) return at + 1;
    else if (source[at] === "\n" || source[at] === "\r") return source.length;
  }
  return source.length;
}

function regexEnd(source: string, start: number): number | null {
  let bracket = false;
  for (let at = start + 1; at < source.length; at++) {
    const char = source[at];
    if (char === "\n" || char === "\r") return null;
    if (char === "\\") at++;
    else if (char === "[") bracket = true;
    else if (char === "]") bracket = false;
    else if (char === "/" && !bracket) {
      at++;
      while (at < source.length && /[a-z]/i.test(source[at])) at++;
      return at;
    }
  }
  return null;
}

function blockEnd(source: string, start: number): number {
  const close = source.indexOf("*/", start + 2);
  return close < 0 ? source.length : close + 2;
}

function templateEnd(source: string, start: number, nesting = 0): number {
  if (nesting > 64) return source.length;
  for (let at = start + 1; at < source.length; at++) {
    const char = source[at];
    if (char === "\\") at++;
    else if (char === "`") return at + 1;
    else if (char === "$" && source[at + 1] === "{") {
      let depth = 1;
      at += 2;
      while (at < source.length && depth > 0) {
        if (source[at] === "'" || source[at] === '"')
          at = quotedEnd(source, at);
        else if (source[at] === "`") at = templateEnd(source, at, nesting + 1);
        else if (source.startsWith("/*", at)) at = blockEnd(source, at);
        else if (source.startsWith("//", at)) {
          const newline = source.indexOf("\n", at + 2);
          at = newline < 0 ? source.length : newline;
        } else if (source[at] === "/") at = regexEnd(source, at) ?? at + 1;
        else {
          if (source[at] === "{") depth++;
          if (source[at] === "}") depth--;
          at++;
        }
      }
      at--;
    }
  }
  return source.length;
}

function specifierValue(raw: string): string | null {
  if (!raw || raw.length > 4_000) return null;
  let value = "";
  for (let at = 0; at < raw.length; at++) {
    let char = raw[at];
    if (char === "\\") {
      char = raw[++at];
      if (!char || /[\nrntbfv0]/.test(char) || char === "\r") return null;
      if (char === "x" || char === "u") {
        const count = char === "x" ? 2 : 4;
        const hex = raw.slice(at + 1, at + count + 1);
        if (hex.length !== count || !/^[\da-f]+$/i.test(hex)) return null;
        char = String.fromCharCode(Number.parseInt(hex, 16));
        at += count;
      }
    }
    if (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) return null;
    value += char;
  }
  return value;
}

type JsxRange = { from: number; to: number };
type JsxResult = { end: number; expressions: JsxRange[] };
type JsxBudget = { remaining: number };
const expressionPrefix = new Set([
  "return",
  "throw",
  "case",
  "delete",
  "void",
  "typeof",
  "in",
  "instanceof",
  "yield",
  "await",
]);
const jsxName = /^[$_\p{ID_Start}][\w.$:\-\p{ID_Continue}]*/u;

/** Balance only JavaScript braces here; the tokenizer later scans each proven
 *  expression separately, so JSX text can never join adjacent JS tokens. */
function jsxExpressionEnd(
  source: string,
  start: number,
  budget: JsxBudget,
  nesting: number,
): number | null {
  if (nesting > 64) {
    budget.remaining = -1;
    return null;
  }
  let depth = 1;
  let canRegex = true;
  let at = start + 1;
  while (at < source.length && --budget.remaining >= 0) {
    const char = source[at];
    if (/\s/.test(char)) at++;
    else if (source.startsWith("/*", at)) at = blockEnd(source, at);
    else if (source.startsWith("//", at)) {
      const newline = source.indexOf("\n", at + 2);
      at = newline < 0 ? source.length : newline;
    } else if (char === "'" || char === '"') {
      at = quotedEnd(source, at);
      canRegex = false;
    } else if (char === "`") {
      at = templateEnd(source, at);
      canRegex = false;
    } else if (char === "/" && canRegex) {
      const end = regexEnd(source, at);
      at = end ?? at + 1;
      canRegex = end === null;
    } else if (char === "<") {
      const child = jsxEnd(source, at, budget, nesting + 1);
      if (child) {
        at = child.end;
        canRegex = false;
      } else {
        at++;
        canRegex = true;
      }
    } else if (wordStart.test(char)) {
      const from = at++;
      while (at < source.length && wordPart.test(source[at])) at++;
      canRegex = expressionPrefix.has(source.slice(from, at));
    } else {
      if (char === "{") depth++;
      if (char === "}" && --depth === 0) return at + 1;
      canRegex = /[({[=,:;!?&|+*%~^<>-]/.test(char);
      at++;
    }
  }
  return null;
}

function jsxTag(
  source: string,
  start: number,
  budget: JsxBudget,
  nesting: number,
):
  | (JsxResult & { name: string; closing: boolean; selfClosing: boolean })
  | null {
  let at = start + 1;
  const closing = source[at] === "/";
  if (closing) at++;
  if (source[at] === ">")
    return {
      name: "",
      closing,
      selfClosing: false,
      end: at + 1,
      expressions: [],
    };
  const name = jsxName.exec(source.slice(at))?.[0];
  if (!name) return null;
  at += name.length;
  const expressions: JsxRange[] = [];
  const space = () => {
    while (at < source.length && /\s/.test(source[at])) at++;
  };
  while (at < source.length && --budget.remaining >= 0) {
    space();
    if (source[at] === ">")
      return { name, closing, selfClosing: false, end: at + 1, expressions };
    if (!closing && source.startsWith("/>", at))
      return { name, closing, selfClosing: true, end: at + 2, expressions };
    if (closing) return null;
    if (source[at] === "{") {
      // A bare attribute expression must be a JSX spread, not a TS constraint.
      if (
        !source
          .slice(at + 1)
          .trimStart()
          .startsWith("...")
      )
        return null;
      const end = jsxExpressionEnd(source, at, budget, nesting + 1);
      if (end === null) return null;
      expressions.push({ from: at + 1, to: end - 1 });
      at = end;
      continue;
    }
    const attribute = jsxName.exec(source.slice(at))?.[0];
    if (!attribute) return null;
    at += attribute.length;
    space();
    if (source[at] !== "=") continue;
    at++;
    space();
    if (source[at] === "'" || source[at] === '"') {
      const close = source.indexOf(source[at], at + 1);
      if (close < 0) return null;
      at = close + 1;
    } else if (source[at] === "{") {
      const end = jsxExpressionEnd(source, at, budget, nesting + 1);
      if (end === null) return null;
      expressions.push({ from: at + 1, to: end - 1 });
      at = end;
    } else return null;
  }
  return null;
}

function jsxEnd(
  source: string,
  start: number,
  budget: JsxBudget,
  nesting = 0,
): JsxResult | null {
  if (nesting > 64) {
    budget.remaining = -1;
    return null;
  }
  if (source[start] !== "<") return null;
  const opening = jsxTag(source, start, budget, nesting);
  if (!opening || opening.closing) return null;
  if (opening.selfClosing) return opening;
  const stack = [opening.name];
  const expressions = [...opening.expressions];
  let at = opening.end;
  while (at < source.length && --budget.remaining >= 0) {
    if (source[at] === "{") {
      const end = jsxExpressionEnd(source, at, budget, nesting + 1);
      if (end === null) return null;
      expressions.push({ from: at + 1, to: end - 1 });
      at = end;
    } else if (source[at] === "<") {
      const tag = jsxTag(source, at, budget, nesting);
      if (!tag) return null;
      expressions.push(...tag.expressions);
      if (tag.closing) {
        if (stack.pop() !== tag.name) return null;
        if (stack.length === 0) return { end: tag.end, expressions };
      } else if (!tag.selfClosing) {
        if (stack.length >= 64) {
          budget.remaining = -1;
          return null;
        }
        stack.push(tag.name);
      }
      at = tag.end;
    } else at++;
  }
  return null;
}

function tokenize(
  source: string,
  jsx = false,
  nesting = 0,
  budget: JsxBudget = { remaining: source.length * 8 + 2_048 },
): Token[] {
  if (nesting > 64) return [];
  const tokens: Token[] = [];
  let at = source.startsWith("#!") ? source.indexOf("\n") : 0;
  if (at < 0) return tokens;
  while (
    at < source.length &&
    tokens.length < 100_000 &&
    budget.remaining >= 0
  ) {
    const char = source[at];
    if (jsx && char === "<") {
      const node = jsxEnd(source, at, budget);
      if (!node) {
        if (budget.remaining < 0) break;
        tokens.push({ kind: "punct", value: "<", from: at, to: at + 1 });
        at++;
        continue;
      }
      tokens.push({ kind: "punct", value: ";", from: at, to: at });
      for (const range of node.expressions) {
        for (const token of tokenize(
          source.slice(range.from, range.to),
          jsx,
          nesting + 1,
          budget,
        )) {
          if (tokens.length >= 100_000) break;
          tokens.push({
            ...token,
            from: token.from + range.from,
            to: token.to + range.from,
          });
        }
        tokens.push({
          kind: "punct",
          value: ";",
          from: range.to,
          to: range.to,
        });
      }
      at = node.end;
    } else if (/\s/.test(char)) at++;
    else if (source.startsWith("//", at)) {
      const newline = source.indexOf("\n", at + 2);
      at = newline < 0 ? source.length : newline;
    } else if (source.startsWith("/*", at)) at = blockEnd(source, at);
    else if (char === "`") at = templateEnd(source, at);
    else if (char === "'" || char === '"') {
      const end = quotedEnd(source, at);
      if (source[end - 1] !== char) break;
      tokens.push({
        kind: "string",
        value: source.slice(at + 1, end - 1),
        from: at + 1,
        to: end - 1,
      });
      at = end;
    } else if (char === "/" && regexEnd(source, at) !== null)
      at = regexEnd(source, at) ?? source.length;
    else if (wordStart.test(char)) {
      const from = at++;
      while (at < source.length && wordPart.test(source[at])) at++;
      tokens.push({
        kind: "word",
        value: source.slice(from, at),
        from,
        to: at,
      });
    } else {
      tokens.push({ kind: "punct", value: char, from: at, to: at + 1 });
      at++;
    }
  }
  return tokens;
}

/** Lexical module strings only; JSX mode also excludes tag text and quoted
 *  attributes while retaining JavaScript brace expressions. No evaluation. */
export function scanPrCodeImports(source: string, jsx = false): PrCodeImport[] {
  if (source.length > PR_CODE_IMPORT_MAX_CHARS) return [];
  const tokens = tokenize(source, jsx);
  const found = new Map<number, PrCodeImport>();
  const add = (token: Token | undefined) => {
    if (token?.kind !== "string") return;
    const specifier = specifierValue(token.value);
    if (specifier !== null)
      found.set(token.from, { from: token.from, to: token.to, specifier });
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== "word" || tokens[index - 1]?.value === ".") continue;
    const next = tokens[index + 1];
    if (
      token.value === "require" ||
      (token.value === "import" && next?.value === "(")
    ) {
      if (next?.value === "(" && [")", ","].includes(tokens[index + 3]?.value))
        add(tokens[index + 2]);
      continue;
    }
    if (token.value === "import" && next?.kind === "string") {
      add(next);
      continue;
    }
    if (token.value !== "import" && token.value !== "export") continue;
    const clauseStart = next?.value === "type" ? tokens[index + 2] : next;
    if (
      token.value === "export" &&
      clauseStart?.value !== "{" &&
      clauseStart?.value !== "*"
    )
      continue;
    if (
      token.value === "import" &&
      (next?.value === "." || next?.value === "(")
    )
      continue;
    let depth = 0;
    for (
      let cursor = index + 1;
      cursor < Math.min(tokens.length, index + 500);
      cursor++
    ) {
      const current = tokens[cursor];
      if (current.value === "{") depth++;
      else if (current.value === "}") depth--;
      if (depth < 0 || current.value === ";" || current.value === "=") break;
      if (depth === 0 && current.value === "from") {
        add(tokens[cursor + 1]);
        break;
      }
      if (
        depth === 0 &&
        [
          "const",
          "let",
          "var",
          "function",
          "class",
          "import",
          "export",
          "return",
        ].includes(current.value)
      )
        break;
    }
  }
  return [...found.values()].sort((a, b) => a.from - b.from);
}
