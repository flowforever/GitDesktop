import { type RefObject, useEffect, useRef, useState } from "react";
import { FULL_OID_RE } from "@/lib/git/oid";
import {
  type MrChatAttachment,
  type MrChatFileContext,
  type MrChatFileVersion,
  paintedMrFile,
  readMrCodeSelection,
} from "./context";

export interface PaintedMrFile {
  path: string;
  lookupPath: string;
  side: "old" | "new";
  view: "diff" | "source";
  headSha: string;
  metadata: MrChatFileContext;
  relatedPaths: string[];
}

function versionOf(
  marker: HTMLElement,
  side: "before" | "after",
): MrChatFileVersion | null {
  const revision = marker.getAttribute(`data-diff-${side}-revision`);
  const path = marker.getAttribute(`data-diff-${side}-path`);
  return revision && FULL_OID_RE.test(revision) && path !== null
    ? { path: path === "" ? null : path, revision }
    : null;
}

function sameVersion(
  left: MrChatFileVersion | null | undefined,
  right: MrChatFileVersion | null | undefined,
) {
  return left?.path === right?.path && left?.revision === right?.revision;
}

function readFile(
  host: HTMLElement,
  headSha?: string | null,
  preferred?: string,
): PaintedMrFile | null {
  const marker = paintedMrFile(host, preferred);
  const paintedHead = marker?.dataset.diffHeadSha ?? headSha;
  if (
    !marker ||
    marker.dataset.diffContextPending === "true" ||
    !paintedHead ||
    !FULL_OID_RE.test(paintedHead) ||
    paintedHead.toLowerCase() !== headSha?.toLowerCase()
  )
    return null;
  const lookupPath = marker.dataset.diffFilePath;
  const side = marker.dataset.diffContentSide === "old" ? "old" : "new";
  const path =
    side === "old"
      ? (marker.dataset.diffOldFilePath ?? lookupPath)
      : lookupPath;
  if (!path || !lookupPath) return null;
  const before = versionOf(marker, "before");
  const after = versionOf(marker, "after");
  return {
    path,
    lookupPath,
    side,
    view: marker.hasAttribute("data-diff-content-side") ? "source" : "diff",
    headSha: paintedHead,
    metadata: { path: lookupPath, before, after },
    relatedPaths: [
      ...new Set(
        [
          lookupPath,
          marker.dataset.diffOldFilePath,
          before?.path,
          after?.path,
        ].filter(
          (path): path is string => typeof path === "string" && path.length > 0,
        ),
      ),
    ],
  };
}

export function useMrChatCodeContext(
  hostRef: RefObject<HTMLElement | null>,
  headSha: string | null | undefined,
  enabled: boolean,
) {
  const [file, setFile] = useState<PaintedMrFile | null>(null);
  const [selection, setSelection] = useState<MrChatAttachment | null>(null);
  const selectionRef = useRef<MrChatAttachment | null>(null);
  const activePath = useRef<string | undefined>(undefined);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !enabled) return;
    const refresh = () => {
      const next = readFile(host, headSha, activePath.current);
      setFile((previous) =>
        previous?.path === next?.path &&
        previous?.lookupPath === next?.lookupPath &&
        previous?.side === next?.side &&
        previous?.view === next?.view &&
        previous?.headSha === next?.headSha &&
        previous?.relatedPaths.join("\0") === next?.relatedPaths.join("\0") &&
        sameVersion(previous?.metadata.before, next?.metadata.before) &&
        sameVersion(previous?.metadata.after, next?.metadata.after)
          ? previous
          : next,
      );
      const selected = selectionRef.current;
      const selectedMarker =
        selected && paintedMrFile(host, selected.lookupPath);
      if (
        selected &&
        (!selectedMarker ||
          selectedMarker.dataset.diffContextPending === "true" ||
          selectedMarker.dataset.diffHeadSha !== selected.headSha ||
          selectedMarker.dataset.diffFilePath !== selected.lookupPath)
      ) {
        selectionRef.current = null;
        setSelection(null);
      }
    };
    const capture = () => {
      const next = readMrCodeSelection(host);
      if (next && next.headSha?.toLowerCase() === headSha?.toLowerCase()) {
        activePath.current = next.lookupPath;
        selectionRef.current = next;
        setSelection(next);
        refresh();
      } else if (document.getSelection()?.isCollapsed === false) {
        selectionRef.current = null;
        setSelection(null);
      }
    };
    const activate = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      const marker = target?.closest<HTMLElement>("[data-diff-file-path]");
      if (
        marker &&
        host.contains(marker) &&
        !marker.closest('[inert],[hidden],[aria-hidden="true"]')
      ) {
        activePath.current = marker.dataset.diffFilePath;
        refresh();
      }
    };
    selectionRef.current = null;
    setSelection(null);
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(host, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "data-diff-file-path",
        "data-diff-old-file-path",
        "data-diff-head-sha",
        "data-diff-content-side",
        "data-diff-context-pending",
        "data-diff-before-path",
        "data-diff-before-revision",
        "data-diff-after-path",
        "data-diff-after-revision",
        "inert",
        "hidden",
        "aria-hidden",
      ],
    });
    document.addEventListener("selectionchange", capture);
    host.addEventListener("mouseup", capture);
    host.addEventListener("keyup", capture);
    host.addEventListener("mousedown", activate);
    host.addEventListener("focusin", activate);
    return () => {
      observer.disconnect();
      document.removeEventListener("selectionchange", capture);
      host.removeEventListener("mouseup", capture);
      host.removeEventListener("keyup", capture);
      host.removeEventListener("mousedown", activate);
      host.removeEventListener("focusin", activate);
    };
  }, [hostRef, headSha, enabled]);
  return {
    file:
      enabled && file?.headSha.toLowerCase() === headSha?.toLowerCase()
        ? file
        : null,
    selection:
      enabled && selection?.headSha?.toLowerCase() === headSha?.toLowerCase()
        ? selection
        : null,
    readFile: () =>
      enabled && hostRef.current
        ? readFile(hostRef.current, headSha, activePath.current)
        : null,
    hasPaintedFile: () =>
      Boolean(hostRef.current?.querySelector("[data-diff-file-path]")),
  };
}
