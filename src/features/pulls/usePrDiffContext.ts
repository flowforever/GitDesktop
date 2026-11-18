import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useDiffPaneHold } from "@/features/diff/diff-pane-hold";
import { lineComposerOpen } from "@/features/diff/whitespace-mode";
import { FULL_OID_RE } from "@/lib/git/oid";
import { prSnapshotComparisonOptions } from "@/lib/git/queries/pr-snapshot";
import type { FileDiff, RemoteLens } from "@/lib/git/types";
import { useRetained } from "@/lib/use-retained";
import { buildPrSnapshotContext } from "./pr-full-context";

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
}) {
  const { phase } = useDiffPaneHold();
  const composerHeld = composerOpen || lineComposerOpen();
  const eligible =
    enabled &&
    lens === "origin" &&
    !!repoPath &&
    number !== undefined &&
    number > 0 &&
    !!headSha &&
    FULL_OID_RE.test(headSha) &&
    data !== undefined &&
    data.filePath === path &&
    !data.isBinary &&
    !data.isTruncated &&
    /^@@ /m.test(data.text) &&
    !/^(?:---|\+\+\+) \/dev\/null(?:\r?$|\t)/m.test(data.text);
  const read = useQuery({
    ...prSnapshotComparisonOptions(
      repoPath ?? "",
      number ?? 0,
      headSha ?? "",
      path,
      lens,
    ),
    enabled: eligible && phase !== "held" && !composerHeld,
  });
  const patch = data?.text;
  const context = useMemo(() => {
    if (
      !eligible ||
      !read.data ||
      read.isPlaceholderData ||
      read.data.oldPath === null ||
      read.data.newPath === null ||
      patch === undefined
    )
      return undefined;
    const result = buildPrSnapshotContext(
      read.data,
      path,
      headSha ?? "",
      patch,
    );
    return result.kind === "ready"
      ? { content: result.content, patch: result.patch }
      : undefined;
  }, [eligible, read.data, read.isPlaceholderData, path, headSha, patch]);
  const key = JSON.stringify([repoPath, lens, number, headSha, path]);
  const value = useMemo(
    () => ({ key, patch: data?.text, context }),
    [key, data?.text, context],
  );
  // A late read must not rebuild a live comment editor, or a held slot. Never
  // retain it across a different request/head/path or a changed partial patch.
  const shown = useRetained(value, phase !== "held" && !composerHeld);
  return shown.key === key && shown.patch === data?.text
    ? shown.context
    : undefined;
}
