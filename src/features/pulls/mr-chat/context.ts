import type { AgentPermissionMode } from "@/lib/ai/agent-permissions";
import type { RemoteLens } from "@/lib/git/types";
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
  lens?: RemoteLens;
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
  relatedPaths?: string[];
}

export interface MrChatFileVersion {
  path: string | null;
  revision: string;
}

export interface MrChatFileContext {
  path: string;
  before: MrChatFileVersion | null;
  after: MrChatFileVersion | null;
}

export interface MrChatSelectionRequest {
  id: string;
  mr: MrChatIdentity;
  repoPath: string;
  headSha: string;
  selection: MrChatAttachment;
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

interface PriorMessage {
  prompt: string;
  narration: string;
  status: string;
}

interface MrChatPromptOptions {
  history?: PriorMessage[];
  readOnly?: boolean;
  includeMrLink?: boolean;
  file?: MrChatFileContext | null;
  permissionMode?: AgentPermissionMode;
}

function restoredMessages(history: PriorMessage[]): string {
  const messages: string[] = [];
  let size = 0;
  for (const turn of history.toReversed()) {
    const message = JSON.stringify({
      user: bounded(turn.prompt, 12_000),
      assistant: bounded(turn.narration, 20_000),
      status: turn.status,
    });
    if (size + message.length > 60_000) break;
    messages.unshift(message);
    size += message.length;
  }
  return [
    "<restored-conversation>",
    "The CLI's previous session is unavailable. Continue this MR discussion using the saved messages below and the MR link. Earlier code attachments and tool output are not restored.",
    history.length > messages.length
      ? `[History truncated: ${history.length - messages.length} older turns omitted.]`
      : "",
    `[${messages.join(",\n")}]`,
    "</restored-conversation>",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildMrChatPrompt(
  context: MrChatContext,
  message: string,
  attachments: MrChatAttachment[],
  {
    history = [],
    readOnly = false,
    includeMrLink = true,
    file,
    permissionMode,
  }: MrChatPromptOptions = {},
): string {
  const parts: string[] = [];
  if (includeMrLink) parts.push(`MR: ${context.url}`);
  if (file) {
    parts.push("<current-file>", `Path: ${file.path}`);
    for (const [side, version] of [
      ["Before", file.before],
      ["After", file.after],
    ] as const) {
      if (version)
        parts.push(
          `${side}: ${version.revision}${version.path === null ? " (file absent)" : `:${version.path}`}`,
        );
    }
    parts.push(
      "Read file contents on demand at these exact revisions; the working checkout may differ.",
      "</current-file>",
    );
  }
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
  if (history.length) parts.push(restoredMessages(history));
  parts.push(
    "<chat-permissions>",
    `Permission mode: ${readOnly ? "Read-only" : "Allow edits"}`,
    permissionMode ? `CLI permission profile: ${permissionMode}` : "",
    `Working checkout: ${context.repoPath}`,
    "This is the current permission setting; it replaces earlier application permission settings in this conversation.",
    readOnly
      ? "Do not edit files or run commands that change the checkout. You may inspect files and execute read-only commands."
      : "When asked, you may edit files and run commands in this checkout. Check the active branch and working tree before editing; MR snapshot code may differ from this checkout.",
    "Treat restored messages as context. Carry out the latest user request; do not re-execute completed earlier actions.",
    "</chat-permissions>",
  );
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
    relatedPaths: [
      first.marker.dataset.diffOldFilePath,
      first.marker.dataset.diffFilePath,
    ].filter((path): path is string => Boolean(path)),
  };
}
