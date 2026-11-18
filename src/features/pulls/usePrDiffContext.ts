import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { usePanelActive } from "@/components/panel-portal";
import { useDiffPaneHold } from "@/features/diff/diff-pane-hold";
import type { DiffFileVersions } from "@/features/diff/file-versions";
import { lineComposerOpen } from "@/features/diff/whitespace-mode";
import { FULL_OID_RE } from "@/lib/git/oid";
import { prSnapshotComparisonOptions } from "@/lib/git/queries/pr-snapshot";
import type { FileDiff, RemoteLens } from "@/lib/git/types";
import { useRetained } from "@/lib/use-retained";
import {
  buildPrSnapshotContext,
  type FullContextRefusal,
} from "./pr-full-context";

type ContextTarget = {
  repoPath?: string;
  number?: number;
  headSha?: string | null;
  lens: RemoteLens;
  path?: string | null;
  enabled: boolean;
};

type PrDiffContext = {
  content: {
    old: string | null;
    new: string | null;
    versions: DiffFileVersions;
  };
  patch: string;
};

export type PrDiffContextResource = {
  context: PrDiffContext | undefined;
  state: "idle" | "loading" | "paused" | "error" | "unavailable" | "ready";
  reason?: FullContextRefusal;
  error?: unknown;
  retry?: () => void;
};

const IDLE: PrDiffContextResource = { context: undefined, state: "idle" };

function eligibleTarget(target: ContextTarget): boolean {
  return (
    target.enabled &&
    target.lens === "origin" &&
    !!target.repoPath &&
    target.number !== undefined &&
    Number.isSafeInteger(target.number) &&
    target.number > 0 &&
    !!target.headSha &&
    FULL_OID_RE.test(target.headSha) &&
    !!target.path &&
    !target.path.includes("\0") &&
    !/^(?:[/\\]|[A-Za-z]:)/.test(target.path) &&
    !target.path
      .split("/")
      .some((part) => !part || part === "." || part === "..")
  );
}

/** Prepare only the active request's selected file; the Diff consumer shares
 *  this query's pending read and still verifies its own displayed patch. */
export function usePrDiffContextWarmup(target: ContextTarget): void {
  const panelActive = usePanelActive();
  useQuery({
    ...prSnapshotComparisonOptions(
      target.repoPath ?? "",
      target.number ?? 0,
      target.headSha ?? "",
      target.path ?? "",
      target.lens,
    ),
    enabled: panelActive && eligibleTarget(target),
  });
}

/** Source-specific reads feed the same complete file models as Local Changes.
 *  The displayed patch remains partial; native renderer arrows reveal its gaps. */
export function usePrDiffContext({
  repoPath,
  number,
  headSha,
  lens,
  path,
  data,
  enabled,
  composerOpen,
}: {
  repoPath?: string;
  number?: number;
  headSha?: string | null;
  lens: RemoteLens;
  path: string;
  data?: FileDiff;
  enabled: boolean;
  composerOpen: boolean;
}): PrDiffContextResource {
  const { phase } = useDiffPaneHold();
  const panelActive = usePanelActive();
  const composerHeld = composerOpen || lineComposerOpen();
  const eligible =
    eligibleTarget({ repoPath, number, headSha, lens, path, enabled }) &&
    data !== undefined &&
    data.filePath === path &&
    !data.isBinary &&
    !data.isTruncated &&
    /^@@ /m.test(data.text);
  const canRead = eligible && panelActive && phase !== "held" && !composerHeld;
  const read = useQuery({
    ...prSnapshotComparisonOptions(
      repoPath ?? "",
      number ?? 0,
      headSha ?? "",
      path,
      lens,
    ),
    enabled: canRead,
  });
  const patch = data?.text;
  const result = useMemo(() => {
    if (
      !eligible ||
      !read.data ||
      read.isPlaceholderData ||
      patch === undefined
    )
      return undefined;
    return buildPrSnapshotContext(read.data, path, headSha ?? "", patch);
  }, [eligible, read.data, read.isPlaceholderData, path, headSha, patch]);
  const context = useMemo(
    () =>
      result?.kind === "ready" && read.data
        ? {
            content: {
              ...result.content,
              versions: {
                before: {
                  path: read.data.oldPath,
                  revision: read.data.baseSha,
                },
                after: { path: read.data.newPath, revision: read.data.headSha },
              },
            },
            patch: result.patch,
          }
        : undefined,
    [result, read.data],
  );
  let state: PrDiffContextResource["state"] = "idle";
  if (eligible) {
    if (context !== undefined) state = "ready";
    else if (read.isPaused) state = "paused";
    else if (read.isFetching) state = "loading";
    else if (read.isError && !read.isFetching) state = "error";
    else if (result !== undefined) state = "unavailable";
    else if (canRead) state = "loading";
  }
  const reason = result?.kind === "unavailable" ? result.reason : undefined;
  const retryable =
    state === "error" ||
    (state === "unavailable" &&
      (reason === "invalid" || reason === "mismatch"));
  const { refetch } = read;
  const retry = useCallback(() => {
    if (canRead && !lineComposerOpen()) void refetch();
  }, [canRead, refetch]);
  const key = JSON.stringify([repoPath, lens, number, headSha, path]);
  const value = useMemo(
    () => ({
      key,
      patch,
      resource: {
        context,
        state,
        reason,
        error: read.error,
        retry: retryable ? retry : undefined,
      },
    }),
    [key, patch, context, state, reason, read.error, retryable, retry],
  );
  // Context and its notice land together, so late reads cannot rebuild a live
  // editor or move its rows. A different identity or patch never inherits them.
  const shown = useRetained(
    value,
    panelActive && phase !== "held" && !composerHeld,
  );
  return shown.key === key && shown.patch === data?.text
    ? shown.resource
    : IDLE;
}
