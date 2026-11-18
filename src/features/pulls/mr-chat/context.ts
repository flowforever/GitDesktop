import { documentId } from "@/lib/stores/work-documents";

export interface MrChatIdentity {
  host: string;
  repoFullName: string;
  number: number;
}

export interface MrChatContext {
  mr: MrChatIdentity;
  repoPath: string;
  url: string;
  title: string;
  body: string;
  baseRefName: string;
  headRefName: string;
  headSha?: string | null;
  files: { path: string }[];
  diff?: string;
  loadDiff?: () => Promise<string>;
  excludedFiles?: number;
}

export interface MrChatAttachment {
  id: string;
  kind: "file" | "selection";
  path: string;
  side: "old" | "new";
  text: string;
  format: "code" | "diff";
  startLine?: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
  revision?: string;
  headSha?: string;
  lookupPath?: string;
}

export const mrChatKey = (mr: MrChatIdentity) => documentId(mr);

export function parseMrChatIdentity(
  raw: string,
  number: number,
): MrChatIdentity | null {
  try {
    const url = new URL(raw);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !Number.isSafeInteger(number) ||
      number <= 0
    )
      return null;
    const match = url.pathname.match(
      /^\/(.+?)(?:\/-\/merge_requests|\/pull|\/pull-requests)\/(\d+)\/?$/,
    );
    if (!match || Number(match[2]) !== number) return null;
    const repoFullName = decodeURIComponent(match[1]);
    if (
      repoFullName
        .split("/")
        .some((part) => !part || part === "." || part === "..")
    )
      return null;
    return { host: url.host.toLowerCase(), repoFullName, number };
  } catch {
    return null;
  }
}

function bounded(text: string, limit: number): string {
  return text.length > limit
    ? `${text.slice(0, limit)}\n[Context truncated: ${text.length - limit} more characters.]`
    : text;
}

export function buildMrChatPrompt(
  context: MrChatContext,
  message: string,
  attachments: MrChatAttachment[],
): string {
  const files = context.files.map((file) => file.path).join("\n");
  const parts = [
    "<merge-request-context>",
    `URL: ${context.url}`,
    `Project: ${context.mr.host}/${context.mr.repoFullName}`,
    `Request: #${context.mr.number}`,
    `Title: ${context.title}`,
    `Branches: ${context.headRefName} → ${context.baseRefName}`,
    `MR head commit: ${context.headSha || "unavailable"}`,
    `Description:\n${bounded(context.body, 20_000)}`,
    `Changed files:\n${bounded(files, 20_000)}`,
    context.excludedFiles
      ? `${context.excludedFiles} file(s) withheld by AI exclusions or unreadable names.`
      : "",
    `MR diff:\n${bounded(context.diff ?? "The MR diff is not available.", 90_000)}`,
    "</merge-request-context>",
  ];
  for (const attachment of attachments) {
    const range = attachment.startLine
      ? `, lines ${attachment.startLine}–${attachment.endLine ?? attachment.startLine}`
      : "";
    parts.push(
      "<attached-code>",
      `Path: ${attachment.path}`,
      `Source: ${attachment.side} side${range}; ${attachment.format === "diff" ? "MR patch" : attachment.kind === "selection" ? "selected displayed code" : "full file"}`,
      `Snapshot: ${attachment.revision ?? `MR diff at head ${attachment.headSha ?? context.headSha ?? "unavailable"}`}`,
      bounded(attachment.text, 90_000),
      "</attached-code>",
    );
  }
  parts.push(`<user-message>\n${message}\n</user-message>`);
  return parts.filter(Boolean).join("\n\n");
}

const CODE =
  ".diff-line-content-raw [data-template], .diff-line-syntax-raw [data-template], [data-diff-content-side] pre";
const BLOCKED =
  '[inert],[hidden],[aria-hidden="true"],[data-diff-line-widget],.diff-line-widget,.cm-editor,textarea,[contenteditable="true"],[role="textbox"]';

function elementOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

export function paintedMrFile(
  host: HTMLElement,
  preferred?: string,
): HTMLElement | null {
  const files = Array.from(
    host.querySelectorAll<HTMLElement>("[data-diff-file-path]"),
  ).filter((element) => !element.closest(BLOCKED));
  return (
    files.find((element) => element.dataset.diffFilePath === preferred) ??
    files[0] ??
    null
  );
}

function lineNumber(row: Element, side: "old" | "new"): number | null {
  const element = row.querySelector(
    `[data-line-${side}-num],.diff-line-${side}-num [data-line-num]`,
  );
  const value = Number(
    element?.getAttribute(`data-line-${side}-num`) ??
      element?.getAttribute("data-line-num"),
  );
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function codeLocation(element: Element) {
  const marker = element.closest<HTMLElement>("[data-diff-file-path]");
  if (!marker || element.closest(BLOCKED)) return null;
  const row = element.closest("tr.diff-line");
  const cell = element.closest(
    '[data-side="old"],[data-side="new"],.diff-line-old-content,.diff-line-new-content',
  );
  let side: "old" | "new";
  if (
    cell?.getAttribute("data-side") === "old" ||
    cell?.classList.contains("diff-line-old-content")
  )
    side = "old";
  else if (
    cell?.getAttribute("data-side") === "new" ||
    cell?.classList.contains("diff-line-new-content")
  )
    side = "new";
  else if (row) side = lineNumber(row, "new") === null ? "old" : "new";
  else {
    const sourceSide = element.closest<HTMLElement>("[data-diff-content-side]")
      ?.dataset.diffContentSide;
    if (sourceSide !== "old" && sourceSide !== "new") return null;
    side = sourceSide;
  }
  const path =
    side === "old"
      ? (marker.dataset.diffOldFilePath ?? marker.dataset.diffFilePath)
      : marker.dataset.diffFilePath;
  const line = row ? lineNumber(row, side) : 1;
  return path && line ? { marker, path, side, line } : null;
}

/** Selections are read from painted code islands; gutters, widgets and mixed sides
 * cannot be represented as one source range. */
export function readMrCodeSelection(
  host: HTMLElement,
): MrChatAttachment | null {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1)
    return null;
  const range = selection.getRangeAt(0);
  const start = elementOf(range.startContainer)?.closest(CODE);
  const end = elementOf(range.endContainer)?.closest(CODE);
  if (!start || !end || !host.contains(start) || !host.contains(end))
    return null;
  const first = codeLocation(start);
  const last = codeLocation(end);
  if (
    !first ||
    !last ||
    first.marker !== last.marker ||
    first.side !== last.side ||
    first.path !== last.path
  )
    return null;
  const pieces: string[] = [];
  let firstLine = first.line;
  let lastLine = last.line;
  const startPrefix = document.createRange();
  startPrefix.selectNodeContents(start);
  startPrefix.setEnd(range.startContainer, range.startOffset);
  const endPrefix = document.createRange();
  endPrefix.selectNodeContents(end);
  endPrefix.setEnd(range.endContainer, range.endOffset);
  const startColumn = start.closest("tr.diff-line")
    ? startPrefix.toString().length
    : (startPrefix.toString().split("\n").at(-1)?.length ?? 0);
  const endColumn = end.closest("tr.diff-line")
    ? endPrefix.toString().replace(/\r?\n$/, "").length
    : (endPrefix.toString().split("\n").at(-1)?.length ?? 0);
  for (const island of first.marker.querySelectorAll(CODE)) {
    if (!range.intersectsNode(island)) continue;
    const location = codeLocation(island);
    if (
      !location ||
      location.side !== first.side ||
      location.path !== first.path
    )
      continue;
    const selected = document.createRange();
    selected.selectNodeContents(island);
    if (island.contains(range.startContainer))
      selected.setStart(range.startContainer, range.startOffset);
    if (island.contains(range.endContainer))
      selected.setEnd(range.endContainer, range.endOffset);
    const text = selected.toString();
    if (!text) continue;
    pieces.push(
      island.closest("tr.diff-line") ? text.replace(/\r?\n$/, "") : text,
    );
    if (!island.closest("tr.diff-line")) {
      const prefix = document.createRange();
      prefix.selectNodeContents(island);
      prefix.setEnd(range.startContainer, range.startOffset);
      firstLine = prefix.toString().split("\n").length;
      lastLine = firstLine + text.split("\n").length - 1;
    }
  }
  if (pieces.length === 0 || pieces.join("\n").length > 90_000) return null;
  return {
    id: crypto.randomUUID(),
    kind: "selection",
    path: first.path,
    side: first.side,
    startLine: firstLine,
    endLine: lastLine,
    startColumn,
    endColumn,
    text: pieces.join("\n"),
    format: "code",
    headSha: first.marker.dataset.diffHeadSha,
    lookupPath: first.marker.dataset.diffFilePath,
  };
}
