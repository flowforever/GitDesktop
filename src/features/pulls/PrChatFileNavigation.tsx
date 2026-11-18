import { type RefObject, useEffect, useRef } from "react";
import { toast } from "sonner";
import { lineComposerOpen } from "@/features/diff/whitespace-mode";
import { useUiStore } from "@/lib/stores/ui";
import { useLatestRef } from "@/lib/use-latest-ref";
import type { MrChatFileNavigationRequest } from "./mr-chat/useMrChatFileNavigation";
import type { PrFileVisit } from "./usePrFileHistory";

const BLOCKED = '[inert],[hidden],[aria-hidden="true"]';

function numberRow(marker: HTMLElement, side: "old" | "new", line: number) {
  return marker
    .querySelector(
      `[data-line-${side}-num="${line}"], [data-side="${side}"] [data-line-num="${line}"], .diff-line-${side}-num [data-line-num="${line}"]`,
    )
    ?.closest<HTMLElement>("tr.diff-line");
}

/** Highlighted source is one pre with nested syntax spans. A native range gives
 * its exact wrapped line position without replacing the highlighted content. */
function revealSourceLine(marker: HTMLElement, line: number): boolean {
  const pre = marker.querySelector("pre");
  if (!pre) return false;
  const text = pre.textContent ?? "";
  let from = 0;
  for (let index = 1; index < line; index++) {
    const next = text.indexOf("\n", from);
    if (next < 0 || next + 1 >= text.length) return false;
    from = next + 1;
  }
  const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  let offset = from;
  while (node && offset > (node.textContent?.length ?? 0)) {
    offset -= node.textContent?.length ?? 0;
    node = walker.nextNode();
  }
  if (!node) return false;
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, Math.min(offset + 1, node.textContent?.length ?? 0));
  const rect = range.getBoundingClientRect();
  for (let host = pre.parentElement; host; host = host.parentElement) {
    if (host.scrollHeight > host.clientHeight && host.clientHeight > 0) {
      const bounds = host.getBoundingClientRect();
      host.scrollTop += rect.top - bounds.top - host.clientHeight / 2;
      break;
    }
    if (host === marker.parentElement) break;
  }
  marker.tabIndex = -1;
  marker.focus({ preventScroll: true });
  return true;
}

type NavigationProps = {
  request: MrChatFileNavigationRequest | undefined;
  scope: { repoPath: string; number: number; lens: string; headSha: string };
  contentRef: RefObject<HTMLDivElement | null>;
  shownPath: string | null;
  kind: "diff" | "full" | "source" | undefined;
  allFiles: boolean;
  enabled: boolean;
  settled: boolean;
  canExpandFull: boolean;
  onNavigate: (visit: PrFileVisit) => void;
  onExpandFull: () => void;
  onConsumed: ((id: string) => void) | undefined;
};

/** Uses the file pane's existing navigation, history, slots and mode switch.
 * A landing never reads a held slot or a model painted for another MR head. */
export function PrChatFileNavigation(props: NavigationProps) {
  const live = useLatestRef(props);
  const retry = useRef<(() => void) | null>(null);
  const request = props.request;
  const scopeKey = JSON.stringify(props.scope);
  useEffect(() => {
    const start = live.current;
    const host = start.contentRef.current;
    if (
      !request ||
      !host ||
      !start.enabled ||
      request.repoPath !== start.scope.repoPath ||
      request.number !== start.scope.number ||
      request.lens !== start.scope.lens ||
      request.headSha.toLowerCase() !== start.scope.headSha.toLowerCase() ||
      lineComposerOpen()
    )
      return;
    let finished = false;
    let expanding = false;
    let ownNavigation = true;
    start.onNavigate({
      path: request.path,
      kind: request.kind,
      allFiles: request.kind === "source" || start.allFiles,
    });
    let epoch = useUiStore.getState().interactionEpoch;
    ownNavigation = false;
    const consume = () => {
      if (finished) return;
      finished = true;
      live.current.onConsumed?.(request.id);
    };
    const current = () =>
      !finished &&
      live.current.enabled &&
      live.current.request?.id === request.id &&
      JSON.stringify(live.current.scope) === scopeKey &&
      useUiStore.getState().interactionEpoch === epoch &&
      !lineComposerOpen();
    const land = () => {
      if (!current()) {
        consume();
        return;
      }
      const value = live.current;
      if (
        value.shownPath !== request.path ||
        !value.settled ||
        host.closest(BLOCKED)
      )
        return;
      if (!request.line) {
        consume();
        return;
      }
      const marker = [
        ...host.querySelectorAll<HTMLElement>("[data-diff-file-path]"),
      ].find(
        (element) =>
          element.dataset.diffFilePath === request.path &&
          !element.closest(BLOCKED),
      );
      if (!marker) return;
      const paintedHead = marker.dataset.diffHeadSha;
      // The hunk-only model can paint before its verified context arrives.
      // Wait for that proof before deciding a line is absent from this Diff.
      if (paintedHead?.toLowerCase() !== request.headSha.toLowerCase()) return;
      if (value.kind === "source") {
        const editor = marker.querySelector<HTMLElement>(".cm-editor");
        if (editor) {
          // Large source already owns CodeMirror; load its API only when a
          // chat link actually requests a line in that large-file surface.
          void import("@uiw/react-codemirror").then(({ EditorView }) => {
            if (!current()) return;
            const view = EditorView.findFromDOM(editor);
            if (view && request.line && request.line <= view.state.doc.lines) {
              view.dispatch({
                effects: EditorView.scrollIntoView(
                  view.state.doc.line(request.line).from,
                  { y: "center" },
                ),
              });
              view.focus();
            } else
              toast.info(
                `Line ${request.line} is not present in ${request.path} at this MR head.`,
              );
            consume();
          });
          return;
        }
        if (!revealSourceLine(marker, request.line))
          toast.info(
            `Line ${request.line} is not present in ${request.path} at this MR head.`,
          );
        consume();
        return;
      }
      const row = numberRow(marker, request.side, request.line);
      if (row) {
        row.scrollIntoView({ block: "center", inline: "nearest" });
        marker.focus({ preventScroll: true });
        consume();
        return;
      }
      if (value.kind === "full") {
        toast.info(
          `Line ${request.line} is not present on the ${request.side} side of ${request.path}.`,
        );
        consume();
        return;
      }
      if (value.kind === "diff" && value.canExpandFull && !expanding) {
        expanding = true;
        ownNavigation = true;
        value.onExpandFull();
        epoch = useUiStore.getState().interactionEpoch;
        ownNavigation = false;
      }
    };
    retry.current = land;
    const observer = new MutationObserver(land);
    observer.observe(host, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "inert",
        "hidden",
        "data-diff-file-path",
        "data-diff-head-sha",
        "data-line-num",
        "data-line-old-num",
        "data-line-new-num",
      ],
    });
    const unsubscribe = useUiStore.subscribe((state) => {
      if (!ownNavigation && state.interactionEpoch !== epoch) consume();
    });
    land();
    return () => {
      observer.disconnect();
      unsubscribe();
      retry.current = null;
      consume();
    };
  }, [request, scopeKey]);
  // Readiness can settle without a DOM mutation (for example a cached slot).
  useEffect(() => {
    retry.current?.();
  });
  return null;
}
