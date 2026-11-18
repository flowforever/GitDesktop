import { ChatCircleIcon } from "@phosphor-icons/react";
import { type RefObject, useCallback, useEffect, useState } from "react";
import { usePanelActive } from "@/components/panel-portal";
import { Button } from "@/components/ui/button";
import { FULL_OID_RE } from "@/lib/git/oid";
import { useDiffLayoutStore } from "@/lib/stores/diff-layout";
import { useLatestRef } from "@/lib/use-latest-ref";
import {
  type MrChatAttachment,
  type MrChatContext,
  type MrChatSelectionRequest,
  mrChatKey,
  readMrCodeSelection,
} from "./context";

type SelectionScope = Pick<MrChatContext, "mr" | "repoPath" | "headSha">;

function scopeKey(
  scope: SelectionScope | null,
  enabled: boolean,
): string | null {
  return enabled && scope?.headSha && FULL_OID_RE.test(scope.headSha)
    ? JSON.stringify([
        scope.repoPath,
        mrChatKey(scope.mr),
        scope.headSha.toLowerCase(),
      ])
    : null;
}

/** A request belongs to one activation of one MR head. Late consumers can only
 * acknowledge the packet they actually validated, never its replacement. */
export function useMrChatSelectionQueue(
  context: SelectionScope | null,
  enabled: boolean,
) {
  const key = scopeKey(context, enabled);
  const [queue, setQueue] = useState<{
    key: string | null;
    generation: number;
    request?: MrChatSelectionRequest;
  }>({ key, generation: 0 });
  if (queue.key !== key) {
    setQueue({ key, generation: queue.generation + 1 });
  }
  const generation = queue.generation;
  const live = useLatestRef({ key, generation });
  const enqueue = useCallback(
    (request: MrChatSelectionRequest) => {
      if (
        key === null ||
        live.current.key !== key ||
        live.current.generation !== generation ||
        scopeKey(request, true) !== key
      )
        return;
      setQueue((current) =>
        current.key === key && current.generation === generation
          ? { ...current, request }
          : current,
      );
    },
    [key, generation],
  );
  const consume = useCallback((id: string) => {
    setQueue((current) =>
      current.request?.id === id ? { ...current, request: undefined } : current,
    );
  }, []);
  return {
    request: queue.key === key && key !== null ? queue.request : undefined,
    enqueue,
    consume,
  };
}

type Candidate = {
  selection: MrChatAttachment;
  range: Range;
  left: number;
  top: number;
};

function sameSelection(a: MrChatAttachment, b: MrChatAttachment): boolean {
  return (
    a.path === b.path &&
    a.lookupPath === b.lookupPath &&
    a.headSha?.toLowerCase() === b.headSha?.toLowerCase() &&
    a.side === b.side &&
    a.startLine === b.startLine &&
    a.endLine === b.endLine &&
    a.startColumn === b.startColumn &&
    a.endColumn === b.endColumn &&
    a.text === b.text
  );
}

function position(host: HTMLElement, range: Range) {
  const rect = range.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  if (
    rect.bottom <= hostRect.top ||
    rect.top >= hostRect.bottom ||
    rect.right <= hostRect.left ||
    rect.left >= hostRect.right
  )
    return null;
  return {
    left: Math.max(
      8,
      Math.min(rect.left - hostRect.left, hostRect.width - 128),
    ),
    top: Math.max(
      6,
      Math.min(rect.top - hostRect.top - 34, hostRect.height - 34),
    ),
  };
}

function readCandidate(host: HTMLElement, headSha: string): Candidate | null {
  const selection = readMrCodeSelection(host);
  if (selection?.headSha?.toLowerCase() !== headSha.toLowerCase()) return null;
  const range = document.getSelection()?.getRangeAt(0);
  if (!range) return null;
  const location = position(host, range);
  return location ? { selection, range, ...location } : null;
}

/** Explicitly attach a painted selection without transferring focus away from
 * the native selection or replacing the question already drafted in chat. */
export function MrChatSelectionAction({
  hostRef,
  context,
  enabled = false,
  onRequest,
}: {
  hostRef: RefObject<HTMLElement | null>;
  context: SelectionScope | null;
  enabled?: boolean;
  onRequest: (request: MrChatSelectionRequest) => void;
}) {
  const panelActive = usePanelActive();
  const active = enabled && panelActive;
  const key = scopeKey(context, active);
  const [state, setState] = useState<{
    key: string | null;
    candidate: Candidate | null;
  }>({ key, candidate: null });
  if (state.key !== key) setState({ key, candidate: null });
  const live = useLatestRef({ key, context, onRequest });

  // This leaf is inside the ref-bearing host, whose ref attaches after child
  // layout effects. Subscribe after the commit so its first selection works.
  useEffect(() => {
    const host = hostRef.current;
    if (key === null || !host) return;
    let armed = false;
    const capture = () => {
      if (!armed) return;
      const current = live.current;
      if (current.key !== key || !current.context?.headSha) return;
      const next = readCandidate(host, current.context.headSha);
      setState((previous) => {
        if (previous.key !== key) return previous;
        if (
          next &&
          previous.candidate &&
          sameSelection(next.selection, previous.candidate.selection) &&
          next.left === previous.candidate.left &&
          next.top === previous.candidate.top
        )
          return previous;
        return next || previous.candidate ? { key, candidate: next } : previous;
      });
    };
    const captureGesture = () => {
      armed = true;
      capture();
    };
    // A held/replaced code root invalidates the action without requiring a new
    // selectionchange event. Mutations must never capture an old selection anew.
    const validate = () => {
      setState((previous) => {
        if (previous.key !== key || !previous.candidate) return previous;
        const headSha = live.current.context?.headSha;
        const next = headSha ? readCandidate(host, headSha) : null;
        return next &&
          sameSelection(next.selection, previous.candidate.selection)
          ? previous
          : { key, candidate: null };
      });
    };
    const observer = new MutationObserver(validate);
    observer.observe(host, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "inert",
        "hidden",
        "aria-hidden",
        "data-diff-file-path",
        "data-diff-old-file-path",
        "data-diff-head-sha",
      ],
    });
    // Scrolling only moves the action; it need not walk every code island to
    // re-read a potentially large selection on each scroll event.
    const reposition = () => {
      setState((previous) => {
        if (previous.key !== key || !previous.candidate) return previous;
        const next = position(host, previous.candidate.range);
        if (!next) return { key, candidate: null };
        return next.left === previous.candidate.left &&
          next.top === previous.candidate.top
          ? previous
          : { key, candidate: { ...previous.candidate, ...next } };
      });
    };
    document.addEventListener("selectionchange", capture);
    host.addEventListener("mouseup", captureGesture);
    host.addEventListener("keyup", captureGesture);
    host.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      observer.disconnect();
      document.removeEventListener("selectionchange", capture);
      host.removeEventListener("mouseup", captureGesture);
      host.removeEventListener("keyup", captureGesture);
      host.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [key, hostRef]);

  const candidate = state.key === key && key !== null ? state.candidate : null;
  if (!candidate) return null;
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      className="absolute z-30 shadow-md"
      style={{ left: candidate.left, top: candidate.top }}
      onPointerDown={(event) => {
        if (event.button === 0) event.preventDefault();
      }}
      onMouseDown={(event) => {
        if (event.button === 0) event.preventDefault();
      }}
      onClick={() => {
        const current = live.current;
        const host = hostRef.current;
        if (current.key !== key || !current.context?.headSha || !host) return;
        const selected = readMrCodeSelection(host);
        if (!selected || !sameSelection(selected, candidate.selection)) return;
        useDiffLayoutStore.getState().setMrChatCollapsed(false);
        current.onRequest({
          id: crypto.randomUUID(),
          mr: current.context.mr,
          repoPath: current.context.repoPath,
          headSha: current.context.headSha,
          selection: selected,
        });
      }}
    >
      <ChatCircleIcon aria-hidden />
      Add to chat
    </Button>
  );
}
