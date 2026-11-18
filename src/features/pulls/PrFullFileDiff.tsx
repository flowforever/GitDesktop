import { useQuery } from "@tanstack/react-query";
import { type ComponentProps, useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
  DegradedListNotice,
  useRetryFocusRescue,
} from "@/features/conversations/ConversationListPanel";
import {
  detailNoticeMessage,
  offlinePendingMessage,
  refreshFailed,
  resolveDetailPane,
} from "@/features/conversations/remote-section-state";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import { DiffContent } from "@/features/diff/DiffSurfaceLazy";
import { useReportPaneSettled } from "@/features/diff/diff-pane-hold";
import { type SlotRead, useSlotRead } from "@/features/diff/file-slot";
import { presentError } from "@/lib/error-summary";
import { FULL_OID_RE } from "@/lib/git/oid";
import { prSnapshotComparisonOptions } from "@/lib/git/queries/pr-snapshot";
import type { RemoteLens } from "@/lib/git/types";
import { PrCodeImportLinks } from "./PrCodeImportLinks";
import {
  PrFileContextMarker,
  prComparisonVersions,
} from "./PrFileContextMarker";
import { PrFullFileLoading } from "./PrFullFileLoading";
import {
  buildPrSnapshotContext,
  type FullContextRefusal,
} from "./pr-full-context";

const REFUSAL: Record<FullContextRefusal, string> = {
  "too-large":
    "Full comparison is too large to display safely. Use Diff to review its changes.",
  binary:
    "Full comparison is unavailable for binary or non-UTF-8 files. Use Diff to review its changes.",
  invalid:
    "Could not verify both complete versions. Refresh the comparison or use Diff.",
  mismatch:
    "Could not verify both complete versions. Refresh the comparison or use Diff.",
};
const EMPTY = {
  added: "Added empty file",
  deleted: "Deleted empty file",
  unchanged: "Both versions are empty.",
};

function ComparisonReadGate({ settled }: { settled: boolean }) {
  useReportPaneSettled(settled);
  return null;
}

/** Read-only complete before/after context from authoritative native versions.
 *  Successful comparisons settle through the renderer, including its lazy load. */
export function PrFullFileDiff({
  repoPath,
  number,
  headSha,
  path,
  lens,
  reportRead,
  onRetry,
  onOpenImport,
  importDisabled,
}: {
  repoPath: string;
  number: number;
  headSha: string;
  path: string;
  lens: RemoteLens;
  reportRead: (read: SlotRead) => void;
  onRetry?: () => void;
  onOpenImport?: ComponentProps<typeof PrCodeImportLinks>["onOpen"];
  importDisabled?: boolean;
}) {
  const enabled = repoPath !== "" && number > 0 && FULL_OID_RE.test(headSha);
  const read = useQuery({
    ...prSnapshotComparisonOptions(repoPath, number, headSha, path, lens),
    enabled,
  });
  useSlotRead(reportRead, {
    isPlaceholderData: read.isPlaceholderData,
    isPending: enabled && read.isPending,
    isPaused: read.isPaused,
  });
  const result = useMemo(
    () =>
      read.data === undefined
        ? null
        : buildPrSnapshotContext(read.data, path, headSha),
    [read.data, path, headSha],
  );
  const fileContent = useMemo(
    () =>
      result?.kind === "ready" && read.data
        ? {
            ...result.content,
            versions: {
              before: { path: read.data.oldPath, revision: read.data.baseSha },
              after: { path: read.data.newPath, revision: read.data.headSha },
            },
          }
        : undefined,
    [result, read.data],
  );
  const pane = resolveDetailPane({
    pending: read.isPending,
    error: read.isError,
    hasData: read.data !== undefined,
    paused: read.isPaused,
    fetching: read.isFetching,
  });
  const failed = refreshFailed(read);
  const retryable =
    pane === "error" ||
    (result?.kind === "unavailable" &&
      (result.reason === "invalid" || result.reason === "mismatch"));
  const { hostRef, retryRef } = useRetryFocusRescue(retryable);
  const retry = () => {
    onRetry?.();
    void read.refetch();
  };
  const retryButton = (
    <Button
      ref={retryRef}
      variant="outline"
      size="sm"
      aria-label="Retry full comparison"
      onClick={retry}
    >
      Retry
    </Button>
  );
  const ready = enabled && result?.kind === "ready";
  const versions = prComparisonVersions(read.data, path, headSha);
  let body;
  if (!enabled)
    body = (
      <DiffPlaceholder message="The MR versions are unavailable. Reload this request." />
    );
  else if (pane === "offline")
    body = (
      <DiffPlaceholder message={offlinePendingMessage("this comparison")} />
    );
  else if (pane === "skeleton")
    body = <PrFullFileLoading message="Loading both file versions…" />;
  else if (pane === "error")
    body = (
      <DiffPlaceholder
        message="Could not load both file versions"
        action={
          <div className="flex max-w-md flex-col items-center gap-2 px-4 text-center text-xs">
            <p>{presentError(read.error).summary}</p>
            <Button
              ref={retryRef}
              variant="outline"
              size="sm"
              aria-label="Retry full comparison"
              onClick={retry}
            >
              Retry
            </Button>
          </div>
        }
      />
    );
  else if (result?.kind === "ready") {
    body = (
      <DiffContent
        key={`${read.data?.baseSha}:${headSha}`}
        filePath={path}
        data={result.data}
        isPending={false}
        isError={false}
        repoPath={repoPath}
        anchorCommit={headSha}
        fullContext
        fileContent={fileContent}
      />
    );
    if (onOpenImport)
      body = (
        <PrCodeImportLinks
          path={path}
          oldPath={read.data?.oldPath ?? undefined}
          onOpen={onOpenImport}
          disabled={importDisabled}
        >
          {body}
        </PrCodeImportLinks>
      );
  } else if (result?.kind === "empty")
    body = <DiffPlaceholder message={EMPTY[result.change]} />;
  else
    body = (
      <DiffPlaceholder
        message={
          REFUSAL[result?.kind === "unavailable" ? result.reason : "invalid"]
        }
        action={retryable ? retryButton : undefined}
      />
    );

  return (
    <section
      ref={hostRef}
      tabIndex={-1}
      aria-label={`Full comparison of ${path}`}
      className="ph-no-capture flex h-full min-h-0 flex-col outline-none"
    >
      {!ready && (
        <div
          role="group"
          aria-label="File path"
          tabIndex={0}
          className="shrink-0 overflow-x-auto border-b px-3 py-1.5 font-mono text-xs whitespace-nowrap text-muted-foreground"
        >
          {path}
        </div>
      )}
      {!ready && (
        <ComparisonReadGate
          settled={
            !enabled ||
            ((!read.isPending || read.isPaused) && !read.isPlaceholderData)
          }
        />
      )}
      <DegradedListNotice
        noun="full comparison"
        degraded={pane === "content-degraded"}
        message={detailNoticeMessage({
          noun: "full comparison",
          isError: failed,
          stale: read.isPlaceholderData,
        })}
        onRetry={failed ? retry : undefined}
        className="border-b px-3 py-1.5"
      />
      {ready ? (
        <div className="min-h-0 flex-1">{body}</div>
      ) : (
        <PrFileContextMarker
          className="min-h-0 flex-1"
          path={path}
          headSha={headSha}
          oldPath={read.data?.oldPath ?? undefined}
          versions={versions}
          pending={
            !enabled || read.isPending || read.isPlaceholderData || !versions
          }
        >
          {body}
        </PrFileContextMarker>
      )}
    </section>
  );
}
