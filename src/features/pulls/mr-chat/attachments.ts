import type { PrSnapshotComparison } from "@/lib/git/api/pr-snapshot";
import type { FileBytes } from "@/lib/git/api/workingtree";
import { buildPrSnapshotContext, decodePrFullFile } from "../pr-full-context";
import type { MrChatAttachment } from "./context";

/** A painted range is accepted only when its exact columns match the authoritative
 * MR snapshot; the current checkout and a refreshed patch cannot prove its bytes. */
export function verifiedMrSelection(
  selection: MrChatAttachment,
  comparison: PrSnapshotComparison,
  headSha: string,
  lookupPath: string,
): MrChatAttachment | null {
  if (
    selection.headSha?.toLowerCase() !== headSha.toLowerCase() ||
    buildPrSnapshotContext(comparison, lookupPath, headSha).kind !== "ready"
  )
    return null;
  const old = selection.side === "old";
  const path = old ? comparison.oldPath : comparison.newPath;
  const content = decodePrFullFile(old ? comparison.before : comparison.after);
  if (
    path !== selection.path ||
    content.kind !== "text" ||
    content.text === null
  )
    return null;
  const verified = verifiedText(
    selection,
    content.text,
    old ? comparison.baseSha : comparison.headSha,
  );
  return verified
    ? {
        ...verified,
        relatedPaths: [comparison.oldPath, comparison.newPath].filter(
          (path): path is string => path !== null,
        ),
      }
    : null;
}

export function verifiedMrSourceSelection(
  selection: MrChatAttachment,
  bytes: FileBytes | null,
  headSha: string,
  path: string,
): MrChatAttachment | null {
  if (
    selection.side !== "new" ||
    selection.path !== path ||
    selection.headSha?.toLowerCase() !== headSha.toLowerCase()
  )
    return null;
  const content = decodePrFullFile(bytes);
  return content.kind === "text" && content.text !== null
    ? verifiedText(selection, content.text, headSha)
    : null;
}

function verifiedText(
  selection: MrChatAttachment,
  text: string,
  revision: string,
): MrChatAttachment | null {
  const { startLine, endLine, startColumn, endColumn } = selection;
  if (
    startLine === undefined ||
    endLine === undefined ||
    startColumn === undefined ||
    endColumn === undefined ||
    ![startLine, endLine, startColumn, endColumn].every(Number.isSafeInteger) ||
    startLine < 1 ||
    endLine < startLine ||
    startColumn < 0 ||
    endColumn < 0
  )
    return null;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const first = lines[startLine - 1];
  const last = lines[endLine - 1];
  if (
    first === undefined ||
    last === undefined ||
    startColumn > first.length ||
    endColumn > last.length ||
    (startLine === endLine && endColumn < startColumn)
  )
    return null;
  const selected =
    startLine === endLine
      ? first.slice(startColumn, endColumn)
      : [
          first.slice(startColumn),
          ...lines.slice(startLine, endLine - 1),
          last.slice(0, endColumn),
        ].join("\n");
  if (selected !== selection.text.replace(/\r\n/g, "\n")) return null;
  return { ...selection, revision };
}
