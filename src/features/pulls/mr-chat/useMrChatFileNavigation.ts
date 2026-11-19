import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { usePanelActive } from "@/components/panel-portal";
import { lineComposerOpen } from "@/features/diff/whitespace-mode";
import { FULL_OID_RE } from "@/lib/git/oid";
import { prSnapshotFilesOptions } from "@/lib/git/queries/pr-snapshot";
import type { RemoteLens } from "@/lib/git/types";
import { useUiStore } from "@/lib/stores/ui";
import { toastErrorWithNote } from "@/lib/toast";
import { type MrChatIdentity, mrChatKey } from "./context";

type FileReference = { path: string; line?: number; column?: number };
type ChangedFile = { path: string; oldPath?: string; deleted?: boolean };

export interface MrChatFileNavigationRequest extends FileReference {
  id: string;
  repoPath: string;
  number: number;
  lens: RemoteLens;
  headSha: string;
  kind: "change" | "source";
  side: "old" | "new";
}

function normalize(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

/** Only local file references are meaningful inside the current MR. Locators
 * stay separate from the path, including a Windows drive's first colon. */
export function parseMrChatFileReference(
  reference: string,
  repoPath: string,
): FileReference | null {
  let path: string;
  try {
    path = decodeURIComponent(reference.trim());
  } catch {
    return null;
  }
  if (!path || /[\0\r\n]/.test(path)) return null;
  const locator = path.match(/(?:#L(\d+)(?:-L?\d+)?|:(\d+)(?::(\d+))?)$/);
  let line: number | undefined;
  let column: number | undefined;
  if (locator) {
    line = Number(locator[1] ?? locator[2]);
    column = locator[3] === undefined ? undefined : Number(locator[3]);
    if (
      !Number.isSafeInteger(line) ||
      line < 1 ||
      (column !== undefined && (!Number.isSafeInteger(column) || column < 1))
    )
      return null;
    path = path.slice(0, locator.index);
  }
  const windows = /^[A-Za-z]:[/\\]/.test(repoPath);
  if (windows) path = path.replace(/\\/g, "/");
  const root = repoPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^(?:[A-Za-z][A-Za-z\d+.-]*:)/.test(path) && !/^[A-Za-z]:\//.test(path))
    return null;
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path)) {
    const prefix = `${root}/`;
    const inside = windows
      ? path.toLowerCase().startsWith(prefix.toLowerCase())
      : path.startsWith(prefix);
    if (!inside) return null;
    path = path.slice(prefix.length);
  }
  const relative = normalize(path);
  if (!relative) return null;
  return {
    path: relative,
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
  };
}

type Navigation = {
  mr: MrChatIdentity | null;
  repoPath: string;
  number: number;
  lens: RemoteLens;
  headSha: string | null | undefined;
  enabled: boolean;
  changedFiles: readonly ChangedFile[];
  onNavigate: () => void;
};

function identity(value: Navigation): string | null {
  return value.enabled &&
    value.mr &&
    value.headSha &&
    FULL_OID_RE.test(value.headSha)
    ? JSON.stringify([
        value.repoPath,
        value.lens,
        mrChatKey(value.mr),
        value.number,
        value.headSha.toLowerCase(),
      ])
    : null;
}

type Target = { path: string; kind: "change" | "source"; side: "old" | "new" };

function changedTargets(files: readonly ChangedFile[], path: string): Target[] {
  const exact = files.find((file) => file.path === path);
  if (exact)
    return [
      { path: exact.path, kind: "change", side: exact.deleted ? "old" : "new" },
    ];
  return files
    .filter((file) => file.oldPath === path)
    .map((file) => ({ path: file.path, kind: "change", side: "old" }));
}

/** Resolve only on a chat-link click. Changed paths need no repository scan;
 * other paths use the exact head snapshot and discard late navigation intent. */
export function useMrChatFileNavigation(input: Navigation) {
  const panelActive = usePanelActive();
  const value = { ...input, enabled: input.enabled && panelActive };
  const key = identity(value);
  const queryClient = useQueryClient();
  const live = useRef<Navigation | null>(null);
  const generation = useRef(0);
  const activation = useRef(0);
  const [queue, setQueue] = useState<{
    key: string | null;
    request?: MrChatFileNavigationRequest;
  }>({ key });
  if (queue.key !== key) setQueue({ key });
  useLayoutEffect(() => {
    if (!live.current || identity(live.current) !== key) generation.current++;
    live.current = value;
  });
  useLayoutEffect(
    () => () => {
      live.current = null;
      generation.current++;
    },
    [],
  );

  const onOpenFile = useCallback(
    async (reference: string, requestedSide?: "old" | "new") => {
      const start = live.current;
      const startKey = start && identity(start);
      if (!start || !startKey || !start.headSha || lineComposerOpen()) return;
      const headSha = start.headSha;
      useUiStore.getState().noteUserInteraction();
      const epoch = useUiStore.getState().interactionEpoch;
      const version = generation.current;
      const request = ++activation.current;
      setQueue({ key: startKey });
      const parsed = parseMrChatFileReference(reference, start.repoPath);
      if (!parsed) {
        toast.info(
          "Use a path inside this repository and a positive line number.",
        );
        return;
      }
      const current = () =>
        live.current !== null &&
        identity(live.current) === startKey &&
        generation.current === version &&
        activation.current === request &&
        useUiStore.getState().interactionEpoch === epoch &&
        !lineComposerOpen();
      const open = (target: Target) => {
        if (!current()) return;
        setQueue({
          key: startKey,
          request: {
            ...parsed,
            ...target,
            side:
              target.kind === "change"
                ? (requestedSide ?? target.side)
                : target.side,
            id: crypto.randomUUID(),
            repoPath: start.repoPath,
            lens: start.lens,
            number: start.number,
            headSha,
          },
        });
        live.current?.onNavigate();
      };
      const ambiguous = () =>
        toast.info(
          `More than one MR file matches ${parsed.path}. Use its repository-relative path.`,
        );
      const direct = changedTargets(start.changedFiles, parsed.path);
      if (direct.length > 1) {
        ambiguous();
        return;
      }
      if (direct.length === 1) {
        open(direct[0]);
        return;
      }
      // Search results are patch anchors, never head-only source references.
      if (requestedSide !== undefined) {
        toast.info(
          "This file is missing from the loaded MR file list. Reload the MR before opening this search result.",
        );
        return;
      }
      try {
        const files = await queryClient.fetchQuery(
          prSnapshotFilesOptions(
            start.repoPath,
            start.number,
            headSha,
            start.lens,
          ),
        );
        if (!current()) return;
        const paths = files
          .filter((file) => !file.undecodable)
          .map((file) => file.path);
        if (paths.includes(parsed.path)) {
          open({ path: parsed.path, kind: "source", side: "new" });
          return;
        }
        const candidates = new Map<string, Target>();
        if (!parsed.path.includes("/")) {
          for (const path of paths) {
            if (path.split("/").at(-1) !== parsed.path) continue;
            candidates.set(
              path,
              changedTargets(start.changedFiles, path)[0] ?? {
                path,
                kind: "source",
                side: "new",
              },
            );
          }
          for (const file of start.changedFiles) {
            if (file.path.split("/").at(-1) === parsed.path)
              candidates.set(file.path, {
                path: file.path,
                kind: "change",
                side: file.deleted ? "old" : "new",
              });
            else if (
              file.oldPath?.split("/").at(-1) === parsed.path &&
              !candidates.has(file.path)
            )
              candidates.set(file.path, {
                path: file.path,
                kind: "change",
                side: "old",
              });
          }
        }
        if (candidates.size === 1) open([...candidates.values()][0]);
        else if (candidates.size > 1) ambiguous();
        else
          toast.info(
            `Could not find ${parsed.path} in this MR snapshot. Check its repository-relative path.`,
          );
      } catch (error) {
        if (current())
          toastErrorWithNote(error, "The current MR file is still open.");
      }
    },
    [queryClient],
  );
  const consume = useCallback((id: string) => {
    setQueue((previous) =>
      previous.request?.id === id ? { key: previous.key } : previous,
    );
  }, []);
  return {
    onOpenFile,
    request: key !== null && queue.key === key ? queue.request : undefined,
    consume,
  };
}
