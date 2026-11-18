import { type RefObject, useEffect, useRef, useState } from "react";
import { FULL_OID_RE } from "@/lib/git/oid";
import {
  type MrChatAttachment,
  paintedMrFile,
  readMrCodeSelection,
} from "./context";

export interface PaintedMrFile {
  path: string;
  lookupPath: string;
  side: "old" | "new";
  headSha: string;
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
  return path && lookupPath
    ? { path, lookupPath, side, headSha: paintedHead }
    : null;
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
        previous?.headSha === next?.headSha
          ? previous
          : next,
      );
      const selected = selectionRef.current;
      const selectedMarker =
        selected && paintedMrFile(host, selected.lookupPath);
      if (
        selected &&
        (!selectedMarker ||
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
  };
}
