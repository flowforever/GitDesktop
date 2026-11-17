import { type ReactNode, useEffect, useEffectEvent, useRef } from "react";
import { useDiffPaneHold } from "@/features/diff/diff-pane-hold";
import {
  PR_CODE_IMPORT_MAX_CHARS,
  type PrCodeImport,
  scanPrCodeImports,
} from "./pr-code-imports";

type Side = "old" | "new";
type Source = { path: string; text: string };
type Island = { element: HTMLElement; line: number; text: string };
type Group = {
  side: Side;
  islands: Island[];
  complete: boolean;
  path?: string;
};
const ISLANDS =
  ".diff-line-content-raw [data-template], .diff-line-syntax-raw [data-template]";
const EXCLUDED =
  '[inert],[data-diff-line-widget],[data-state="widget"],[data-state="extend"],.diff-line-widget,.diff-line-extend,.cm-editor,[contenteditable="true"],textarea,[role="textbox"]';
const LINKS = "a[data-pr-code-import]";
const OWNED = "a[data-pr-code-import-owned]";
const lineText = (text: string) => text.replace(/\r?\n$/, "");

function sourceLine(row: HTMLElement, side: Side): number | null {
  const number = row.querySelector(
    `[data-line-${side}-num], .diff-line-${side}-num [data-line-num]`,
  );
  const value =
    number?.getAttribute(`data-line-${side}-num`) ??
    number?.getAttribute("data-line-num");
  const line = value ? Number(value) : 0;
  return Number.isSafeInteger(line) && line > 0 ? line : null;
}

function collectGroups(
  host: HTMLElement,
  path: string,
  oldPath?: string,
): Group[] {
  const groups: Group[] = [];
  const rows: Record<Side, Island[]> = { old: [], new: [] };
  for (const pre of host.querySelectorAll<HTMLElement>("pre.gd-code")) {
    if (!pre.closest(EXCLUDED))
      groups.push({
        side: "new",
        complete: true,
        path,
        islands: [{ element: pre, line: 1, text: pre.textContent ?? "" }],
      });
  }
  for (const element of host.querySelectorAll<HTMLElement>(ISLANDS)) {
    if (element.closest(EXCLUDED) || element.closest("pre.gd-code")) continue;
    const row = element.closest<HTMLElement>("tr.diff-line");
    if (!row) {
      groups.push({
        side: "new",
        complete: true,
        path,
        islands: [{ element, line: 1, text: element.textContent ?? "" }],
      });
      continue;
    }
    const splitSide = element.closest(".diff-line-old-content")
      ? "old"
      : element.closest(".diff-line-new-content")
        ? "new"
        : null;
    for (const side of ["new", "old"] as const) {
      if (splitSide !== null && side !== splitSide) continue;
      const line = sourceLine(row, side);
      if (line !== null)
        rows[side].push({
          element,
          line,
          text: lineText(element.textContent ?? ""),
        });
    }
  }
  // Shared unified context takes the new-side path; deleted rows take oldPath.
  for (const side of ["new", "old"] as const) {
    rows[side].sort((a, b) => a.line - b.line);
    let group: Group | null = null;
    for (const island of rows[side]) {
      if (!group || island.line !== (group.islands.at(-1)?.line ?? 0) + 1) {
        group = {
          side,
          complete: island.line === 1,
          path: side === "old" ? oldPath : path,
          islands: [],
        };
        groups.push(group);
      }
      group.islands.push(island);
    }
  }
  return groups;
}

function position(root: HTMLElement, offset: number, end: boolean) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let at = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (offset < at + length || (end && offset === at + length))
      return { node, offset: offset - at };
    at += length;
  }
  return null;
}

function markImport(
  host: HTMLElement,
  island: Island,
  item: PrCodeImport,
  sourcePath: string,
) {
  const element = island.element;
  const currentText = element.textContent ?? "";
  if (
    !host.isConnected ||
    !host.contains(element) ||
    element.closest(EXCLUDED) ||
    (currentText !== island.text && lineText(currentText) !== island.text)
  )
    return;
  const from = position(element, item.from, false);
  const to = position(element, item.to, true);
  const blocked = `${LINKS},.hljs-comment,.token.comment`;
  if (
    !from ||
    !to ||
    from.node.parentElement?.closest(blocked) ||
    to.node.parentElement?.closest(blocked)
  )
    return;
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  const anchor = document.createElement("a");
  anchor.href = "#mr-import";
  anchor.draggable = false;
  anchor.dataset.prCodeImport = item.specifier;
  anchor.dataset.prCodeSource = sourcePath;
  anchor.dataset.prCodeImportOwned = "";
  anchor.setAttribute("aria-label", item.specifier);
  anchor.title = "Open import at MR head";
  anchor.className =
    "cursor-pointer hover:underline underline-offset-2 focus-visible:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50";
  anchor.append(range.extractContents());
  range.insertNode(anchor);
}

function markGroup(host: HTMLElement, group: Group) {
  if (group.path === undefined) return;
  const text = group.islands.map((island) => island.text).join("\n");
  for (const item of scanPrCodeImports(
    text,
    /\.[jt]sx$/i.test(group.path),
  ).reverse()) {
    let at = 0;
    for (const island of group.islands) {
      if (item.from >= at && item.to <= at + island.text.length) {
        markImport(
          host,
          island,
          { ...item, from: item.from - at, to: item.to - at },
          group.path,
        );
        break;
      }
      at += island.text.length + 1;
    }
  }
}

type Proof = Source & { imports: PrCodeImport[]; starts: number[] };
function sourceProof(source: Source | null): Proof | null {
  if (!source || !source.path || source.text.length > PR_CODE_IMPORT_MAX_CHARS)
    return null;
  const starts = [0];
  for (let at = 0; at < source.text.length; at++)
    if (source.text[at] === "\n") starts.push(at + 1);
  return {
    ...source,
    starts,
    imports: scanPrCodeImports(source.text, /\.[jt]sx$/i.test(source.path)),
  };
}

function markProven(host: HTMLElement, group: Group, proof: Proof) {
  const islands = new Map(group.islands.map((island) => [island.line, island]));
  for (const item of [...proof.imports].reverse()) {
    let low = 0;
    let high = proof.starts.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (proof.starts[middle] <= item.from) low = middle;
      else high = middle;
    }
    const island = islands.get(low + 1);
    if (!island) continue;
    const start = proof.starts[low];
    const end = proof.starts[low + 1] ?? proof.text.length;
    if (item.to > end || lineText(proof.text.slice(start, end)) !== island.text)
      continue;
    markImport(
      host,
      island,
      { ...item, from: item.from - start, to: item.to - start },
      proof.path,
    );
  }
}

/** Only unmanaged HTML islands are decorated. Native editor marks can delegate
 *  through the same data-pr-code-import / data-pr-code-source link contract. */
export function PrCodeImportLinks({
  children,
  path,
  oldPath,
  onOpen,
  getSource,
  disabled = false,
}: {
  children: ReactNode;
  path: string;
  oldPath?: string;
  onOpen: (specifier: string, sourcePath: string) => void;
  getSource?: (side: Side) => Promise<Source | null>;
  disabled?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const { interactive } = useDiffPaneHold();
  const active = useEffectEvent(() => !disabled && interactive);
  const activate = useEffectEvent(
    (anchor: HTMLAnchorElement, pointer: boolean) => {
      if (!active() || anchor.closest("[inert]")) return;
      if (pointer && window.getSelection()?.isCollapsed === false) return;
      const specifier = anchor.dataset.prCodeImport;
      const sourcePath = anchor.dataset.prCodeSource;
      if (specifier && sourcePath) onOpen(specifier, sourcePath);
    },
  );
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const linkFor = (event: Event) => {
      const target = event.target;
      const element =
        target instanceof Element
          ? target
          : target instanceof Node
            ? target.parentElement
            : null;
      const anchor = element?.closest<HTMLAnchorElement>(LINKS);
      return anchor && host.contains(anchor) ? anchor : null;
    };
    const down = (event: Event) => {
      if (linkFor(event)) event.stopPropagation();
    };
    const click = (event: MouseEvent) => {
      const anchor = linkFor(event);
      if (!anchor) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.button === 0) activate(anchor, true);
    };
    const key = (event: KeyboardEvent) => {
      const anchor = linkFor(event);
      if (!anchor || event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) activate(anchor, false);
    };
    host.addEventListener("mousedown", down, true);
    host.addEventListener("pointerdown", down, true);
    host.addEventListener("click", click, true);
    host.addEventListener("auxclick", click, true);
    host.addEventListener("keydown", key, true);
    return () => {
      host.removeEventListener("mousedown", down, true);
      host.removeEventListener("pointerdown", down, true);
      host.removeEventListener("click", click, true);
      host.removeEventListener("auxclick", click, true);
      host.removeEventListener("keydown", key, true);
    };
  }, []);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || disabled || !interactive) return;
    let cancelled = false;
    let version = 0;
    let signature = "";
    const proofs = new Map<Side, Promise<Proof | null>>();
    const options = {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "inert",
        "data-line-num",
        "data-line-old-num",
        "data-line-new-num",
      ],
    };
    const mutate = (run: () => void) => {
      observer.disconnect();
      try {
        if (!cancelled && active()) run();
      } finally {
        if (!cancelled) observer.observe(host, options);
      }
    };
    const refresh = () => {
      if (cancelled || !active() || host.closest("[inert]")) return;
      const groups = collectGroups(host, path, oldPath);
      const nextSignature = JSON.stringify(
        groups.map((group) => [
          group.side,
          group.path,
          group.islands.map((island) => [island.line, island.text]),
        ]),
      );
      if (nextSignature !== signature) {
        signature = nextSignature;
        version++;
        proofs.clear();
      }
      const current = version;
      for (const group of groups) {
        if (group.complete && group.path !== undefined)
          mutate(() => markGroup(host, group));
        else if (
          getSource &&
          group.islands.some((island) =>
            /\b(import|export|require|from)\b/.test(island.text),
          )
        ) {
          let proof = proofs.get(group.side);
          if (!proof) {
            proof = Promise.resolve()
              .then(() =>
                cancelled || !active() ? null : getSource(group.side),
              )
              .then(sourceProof)
              .catch(() => null);
            proofs.set(group.side, proof);
          }
          void proof.then((value) => {
            if (!value || cancelled || version !== current || !active()) return;
            mutate(() => markProven(host, group, value));
          });
        }
      }
    };
    const observer = new MutationObserver(refresh);
    refresh();
    observer.observe(host, options);
    return () => {
      cancelled = true;
      observer.disconnect();
      for (const anchor of host.querySelectorAll(OWNED))
        anchor.replaceWith(...anchor.childNodes);
    };
  }, [path, oldPath, getSource, disabled, interactive]);
  return (
    <div ref={hostRef} className="h-full min-h-0">
      {children}
    </div>
  );
}
