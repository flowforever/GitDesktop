import type { FileBytes } from "../../lib/git/api/workingtree.ts";
import { parseHunks } from "../../lib/git/hunks.ts";
import type { FileDiff } from "../../lib/git/types/workingtree.ts";
import { DIFF_MAX_LINE_CHARS } from "../diff/cap-diff.ts";

export const FULL_FILE_MAX_BYTES = 400_000;
const MAX_ROWS = 5_000;
const MAX_PATCH_CHARS = 500_000;

export type FullContextRefusal =
  | "invalid"
  | "mismatch"
  | "binary"
  | "too-large";
type Unavailable = { kind: "unavailable"; reason: FullContextRefusal };
type Line = { text: string; terminated: boolean };
type Row = { prefix: " " | "+" | "-"; text: string; noNewline: boolean };

const refuse = (reason: FullContextRefusal): Unavailable => ({
  kind: "unavailable",
  reason,
});

/** Strict decoding keeps the BOM and CR bytes that native git compares. */
export function decodePrFullFile(
  data: FileBytes | null,
): { kind: "text"; text: string | null } | Unavailable {
  if (data === null) return { kind: "text", text: null };
  if (data.tooLarge || (data.size !== null && data.size > FULL_FILE_MAX_BYTES))
    return refuse("too-large");
  if (data.mime !== null) return refuse("binary");
  if (typeof data.base64 !== "string") return refuse("invalid");
  if (data.base64.length > Math.ceil(FULL_FILE_MAX_BYTES / 3) * 4)
    return refuse("too-large");
  try {
    const raw = atob(data.base64);
    if (raw.length > FULL_FILE_MAX_BYTES) return refuse("too-large");
    const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
    if (bytes.includes(0)) return refuse("binary");
    return {
      kind: "text",
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      ),
    };
  } catch {
    return refuse("binary");
  }
}

function tooManyLines(text: string, limit = MAX_ROWS): boolean {
  let count = 0;
  for (const char of text) if (char === "\n" && ++count > limit) return true;
  return count + (text !== "" && !text.endsWith("\n") ? 1 : 0) > limit;
}

function lines(text: string | null): Line[] {
  if (!text) return [];
  const terminated = text.endsWith("\n");
  const values = text.split("\n");
  if (terminated) values.pop();
  return values.map((value, index) => ({
    text: value,
    terminated: index < values.length - 1 || terminated,
  }));
}

function equal(a: Line | undefined, b: Line | undefined): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.text === b.text &&
    a.terminated === b.terminated
  );
}

function pathToken(prefix: string, path: string | null): string {
  if (path === null) return "/dev/null";
  const token = `${prefix}/${path}`;
  for (let i = 0; i < token.length; i++) {
    const code = token.charCodeAt(i);
    if (
      code < 33 ||
      code === 127 ||
      token[i] === '"' ||
      token[i] === "\\" ||
      /\s/.test(token[i])
    )
      return JSON.stringify(token);
  }
  return token;
}

/** Hunk alignment is accepted only when every row AND omitted gap matches both
 *  independently read versions. Forge patches and derived totals are not proof. */
export function buildPrFullContext({
  path,
  oldPath,
  newPath,
  before,
  after,
  patch,
}: {
  path: string;
  oldPath: string | null;
  newPath: string | null;
  before: string | null;
  after: string | null;
  patch: string | null;
}):
  | {
      kind: "ready";
      data: FileDiff;
      content: { old: string | null; new: string | null };
    }
  | { kind: "empty"; change: "added" | "deleted" | "unchanged" }
  | Unavailable {
  if (
    !path ||
    oldPath === "" ||
    newPath === "" ||
    (oldPath === null && newPath === null) ||
    (oldPath === null) !== (before === null) ||
    (newPath === null) !== (after === null) ||
    (newPath ?? oldPath) !== path
  )
    return refuse("invalid");
  if (
    path.length > DIFF_MAX_LINE_CHARS ||
    (oldPath?.length ?? 0) > DIFF_MAX_LINE_CHARS ||
    (newPath?.length ?? 0) > DIFF_MAX_LINE_CHARS
  )
    return refuse("too-large");
  const oldText = before ?? "";
  const newText = after ?? "";
  if (oldText.includes("\0") || newText.includes("\0")) return refuse("binary");
  if (
    oldText.length + newText.length > FULL_FILE_MAX_BYTES ||
    tooManyLines(oldText) ||
    tooManyLines(newText) ||
    (patch?.length ?? 0) > MAX_PATCH_CHARS ||
    (patch !== null && tooManyLines(patch, MAX_ROWS * 2 + 64))
  )
    return refuse("too-large");
  const oldLines = lines(before);
  const newLines = lines(after);
  const out: string[] = [];
  const emit = (prefix: string, line: Line) => {
    out.push(`${prefix}${line.text}`);
    if (!line.terminated) out.push("\\ No newline at end of file");
  };
  let oldAt = 0;
  let newAt = 0;
  if (before === null) {
    for (const line of newLines) emit("+", line);
  } else if (after === null) {
    for (const line of oldLines) emit("-", line);
  } else {
    if (typeof patch !== "string") return refuse("invalid");
    const parsed = parseHunks(patch);
    if (
      patch !== "" &&
      (!parsed.fileHeader.startsWith("diff --git ") ||
        parsed.fileHeader
          .split("\n")
          .filter((line) => line.startsWith("diff --git ")).length !== 1)
    )
      return refuse("invalid");
    for (const hunk of parsed.hunks) {
      const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(
        hunk.header,
      );
      if (range === null) return refuse("invalid");
      const oldStart = Number(range[1]);
      const oldCount = range[2] === undefined ? 1 : Number(range[2]);
      const newStart = Number(range[3]);
      const newCount = range[4] === undefined ? 1 : Number(range[4]);
      if (
        ![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger) ||
        (oldCount > 0 && oldStart === 0) ||
        (newCount > 0 && newStart === 0)
      )
        return refuse("invalid");
      const oldIndex = oldCount === 0 ? oldStart : oldStart - 1;
      const newIndex = newCount === 0 ? newStart : newStart - 1;
      if (
        oldIndex < oldAt ||
        newIndex < newAt ||
        oldIndex + oldCount > oldLines.length ||
        newIndex + newCount > newLines.length
      )
        return refuse("invalid");
      if (oldIndex - oldAt !== newIndex - newAt) return refuse("mismatch");
      while (oldAt < oldIndex) {
        if (!equal(oldLines[oldAt], newLines[newAt])) return refuse("mismatch");
        emit(" ", oldLines[oldAt++]);
        newAt++;
      }
      const rows: Row[] = [];
      const body = hunk.text.split("\n").slice(1, -1);
      for (const line of body) {
        if (line === "\\ No newline at end of file") {
          const last = rows.at(-1);
          if (!last || last.noNewline) return refuse("invalid");
          last.noNewline = true;
        } else {
          const prefix = line[0];
          if (prefix !== " " && prefix !== "+" && prefix !== "-")
            return refuse("invalid");
          rows.push({ prefix, text: line.slice(1), noNewline: false });
        }
      }
      let consumedOld = 0;
      let consumedNew = 0;
      for (const row of rows) {
        const oldLine = row.prefix === "+" ? undefined : oldLines[oldAt];
        const newLine = row.prefix === "-" ? undefined : newLines[newAt];
        const matches = (line: Line | undefined) =>
          line !== undefined &&
          line.text === row.text &&
          line.terminated === !row.noNewline;
        if (
          (row.prefix !== "+" && !matches(oldLine)) ||
          (row.prefix !== "-" && !matches(newLine))
        )
          return refuse("mismatch");
        const line = oldLine ?? newLine;
        if (line === undefined) return refuse("invalid");
        emit(row.prefix, line);
        if (row.prefix !== "+") {
          oldAt++;
          consumedOld++;
        }
        if (row.prefix !== "-") {
          newAt++;
          consumedNew++;
        }
      }
      if (consumedOld !== oldCount || consumedNew !== newCount)
        return refuse("invalid");
    }
    if (oldLines.length - oldAt !== newLines.length - newAt)
      return refuse("mismatch");
    while (oldAt < oldLines.length) {
      if (!equal(oldLines[oldAt], newLines[newAt])) return refuse("mismatch");
      emit(" ", oldLines[oldAt++]);
      newAt++;
    }
  }
  if (out.length === 0)
    return {
      kind: "empty",
      change:
        before === null ? "added" : after === null ? "deleted" : "unchanged",
    };
  if (out.length + 1 > MAX_ROWS) return refuse("too-large");
  const displayOld = oldPath ?? newPath;
  const displayNew = newPath ?? oldPath;
  const output = [
    `diff --git ${pathToken("a", displayOld)} ${pathToken("b", displayNew)}`,
    `--- ${pathToken("a", oldPath)}`,
    `+++ ${pathToken("b", newPath)}`,
    `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@`,
    ...out,
  ];
  if (output.some((line) => line.length > DIFF_MAX_LINE_CHARS))
    return refuse("too-large");
  const text = `${output.join("\n")}\n`;
  if (text.length > MAX_PATCH_CHARS) return refuse("too-large");
  return {
    kind: "ready",
    content: { old: before, new: after },
    data: {
      filePath: path,
      text,
      isBinary: false,
      isTruncated: false,
      ...(oldPath !== null && newPath !== null && oldPath !== newPath
        ? { oldPath }
        : {}),
    },
  };
}
