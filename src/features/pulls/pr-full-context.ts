import type { PrSnapshotComparison } from "../../lib/git/api/pr-snapshot.ts";
import type { FileBytes } from "../../lib/git/api/workingtree.ts";
import {
  sectionFilePath,
  sectionOldFilePath,
} from "../../lib/git/diff-split.ts";
import { parseHunks } from "../../lib/git/hunks.ts";
import { FULL_OID_RE } from "../../lib/git/oid.ts";
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
type HunkRange = {
  oldIndex: number;
  oldCount: number;
  newIndex: number;
  newCount: number;
};
type SnapshotContext =
  | Exclude<ReturnType<typeof buildPrFullContext>, { kind: "ready" }>
  | (Extract<ReturnType<typeof buildPrFullContext>, { kind: "ready" }> & {
      /** Display text; a supplied partial patch keeps its hunk boundaries. */
      patch: string;
    });

const refuse = (reason: FullContextRefusal): Unavailable => ({
  kind: "unavailable",
  reason,
});

function hunkRange(header: string): HunkRange | null {
  const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(
    header,
  );
  if (range === null) return null;
  const oldStart = Number(range[1]);
  const oldCount = range[2] === undefined ? 1 : Number(range[2]);
  const newStart = Number(range[3]);
  const newCount = range[4] === undefined ? 1 : Number(range[4]);
  if (
    ![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger) ||
    (oldCount > 0 && oldStart === 0) ||
    (newCount > 0 && newStart === 0)
  )
    return null;
  return {
    oldIndex: oldCount === 0 ? oldStart : oldStart - 1,
    oldCount,
    newIndex: newCount === 0 ? newStart : newStart - 1,
    newCount,
  };
}

/** GitLab can omit the space on an empty context row. Restore only that prefix,
 *  under the hunk's remaining counts and exact matching bytes on BOTH sides. */
function canonicalPartialPatch(
  patch: string,
  before: string,
  after: string,
): string | Unavailable {
  if (
    patch.length > MAX_PATCH_CHARS ||
    tooManyLines(patch, MAX_ROWS * 2 + 64) ||
    before.length + after.length > FULL_FILE_MAX_BYTES ||
    tooManyLines(before) ||
    tooManyLines(after)
  )
    return refuse("too-large");
  const oldLines = lines(before);
  const newLines = lines(after);
  const records = patch.split("\n");
  let normalized: string[] | undefined;
  let inHunk = false;
  let oldAt = 0;
  let newAt = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.startsWith("@@")) {
      if (oldRemaining !== 0 || newRemaining !== 0) return refuse("invalid");
      const range = hunkRange(record);
      if (
        !range ||
        range.oldIndex < oldAt ||
        range.newIndex < newAt ||
        range.oldIndex + range.oldCount > oldLines.length ||
        range.newIndex + range.newCount > newLines.length
      )
        return refuse("invalid");
      oldAt = range.oldIndex;
      newAt = range.newIndex;
      oldRemaining = range.oldCount;
      newRemaining = range.newCount;
      inHunk = true;
      continue;
    }
    // The final split segment is a delimiter, never a context record.
    if (!inHunk || (index === records.length - 1 && record === "")) continue;
    if (record === "\\ No newline at end of file") continue;
    let prefix = record[0];
    if (record === "" || record === "\r") {
      if (oldRemaining <= 0 || newRemaining <= 0) return refuse("invalid");
      if (oldLines[oldAt]?.text !== record || newLines[newAt]?.text !== record)
        return refuse("mismatch");
      normalized ??= [...records];
      normalized[index] = ` ${record}`;
      prefix = " ";
    }
    if (prefix !== " " && prefix !== "+" && prefix !== "-")
      return refuse("invalid");
    if (prefix !== "+") {
      oldAt++;
      oldRemaining--;
    }
    if (prefix !== "-") {
      newAt++;
      newRemaining--;
    }
    if (oldRemaining < 0 || newRemaining < 0) return refuse("invalid");
  }
  if (oldRemaining !== 0 || newRemaining !== 0) return refuse("invalid");
  return normalized?.join("\n") ?? patch;
}

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

function validBytes(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    (data.base64 === null || typeof data.base64 === "string") &&
    (data.mime === null || typeof data.mime === "string") &&
    typeof data.tooLarge === "boolean" &&
    (data.size === null ||
      (typeof data.size === "number" &&
        Number.isFinite(data.size) &&
        data.size >= 0))
  );
}

/** The same pinned pair backs Full file and collapsed Diff context. Supplying
 *  a displayed patch additionally proves its rows and every omitted gap. */
export function buildPrSnapshotContext(
  data: PrSnapshotComparison,
  path: string,
  headSha: string,
  displayedPatch?: string,
): SnapshotContext {
  if (
    !data ||
    typeof data.headSha !== "string" ||
    typeof data.baseSha !== "string" ||
    !FULL_OID_RE.test(data.baseSha) ||
    data.headSha.toLowerCase() !== headSha.toLowerCase() ||
    (data.oldPath !== null && typeof data.oldPath !== "string") ||
    (data.newPath !== null && typeof data.newPath !== "string") ||
    (data.patch !== null && typeof data.patch !== "string") ||
    !validBytes(data.before) ||
    !validBytes(data.after)
  )
    return refuse("invalid");
  if (
    displayedPatch !== undefined &&
    (sectionFilePath(displayedPatch) !== (data.newPath ?? data.oldPath) ||
      sectionOldFilePath(displayedPatch) !== (data.oldPath ?? undefined))
  )
    return refuse("mismatch");
  const before = decodePrFullFile(data.before);
  if (before.kind === "unavailable") return before;
  const after = decodePrFullFile(data.after);
  if (after.kind === "unavailable") return after;
  const patch =
    displayedPatch !== undefined && before.text !== null && after.text !== null
      ? canonicalPartialPatch(displayedPatch, before.text, after.text)
      : (displayedPatch ?? data.patch);
  if (patch !== null && typeof patch !== "string") return patch;
  const result = buildPrFullContext({
    path,
    oldPath: data.oldPath,
    newPath: data.newPath,
    before: before.text,
    after: after.text,
    patch,
  });
  return result.kind === "ready"
    ? {
        ...result,
        patch:
          displayedPatch !== undefined && patch !== null
            ? patch
            : result.data.text,
      }
    : result;
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
      const range = hunkRange(hunk.header);
      if (range === null) return refuse("invalid");
      const { oldIndex, oldCount, newIndex, newCount } = range;
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
