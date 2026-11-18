import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ClockIcon,
  FilesIcon,
} from "@phosphor-icons/react";
import {
  type ComponentProps,
  lazy,
  Suspense,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { DetailRailRow } from "@/components/detail-rail";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
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
import type { MentionSource } from "@/features/conversations/useMentionCandidates";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import {
  DiffContent,
  type DiffLineAnchor,
  type LineWidget,
} from "@/features/diff/DiffSurfaceLazy";
import { useReportPaneSettled } from "@/features/diff/diff-pane-hold";
import {
  FileSlots,
  keyedPaneView,
  placeholderPaneView,
  type SlotRead,
  useFileSlots,
  useSlotRead,
  useSlotRetained,
  useSlotWidget,
} from "@/features/diff/file-slot";
import {
  LAYOUT_COMPOSER_HELD,
  lineComposerOpen,
} from "@/features/diff/whitespace-mode";
import { TimeTrackingControls } from "@/features/issues/RemoteIssueViewParts";
import { presentError } from "@/lib/error-summary";
import { sectionIsBinary, sectionOldFilePath } from "@/lib/git/diff-split";
import { FULL_OID_RE } from "@/lib/git/oid";
import {
  type PendingThreadWrites,
  useAddMrSpentTime,
  useGlMrTimeStats,
  useObjectsPresent,
  useSetMrTimeEstimate,
} from "@/lib/git/queries";
import { usePrSnapshotFiles } from "@/lib/git/queries/pr-snapshot";
import type {
  ForgeProvider,
  RemoteLens,
  ReviewThreadOut,
} from "@/lib/git/types";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { ACT_PENDING_REASON } from "@/lib/offline-writes";
import type { ReviewDraft } from "@/lib/pulls/review-drafts";
import { useUiStore } from "@/lib/stores/ui";
import { cn } from "@/lib/utils";
import { DraftCommentCard } from "./PendingReviewBar";
import { PrChangedFilesNav } from "./PrChangedFilesNav";
import { PrChangesNav } from "./PrChangesNav";
import { PrCodeImportLinks } from "./PrCodeImportLinks";
import { PrFilesTree, type PrTreeFile } from "./PrFilesTree";
import { PrFullFileLoading } from "./PrFullFileLoading";
import { PrImportTargetPicker } from "./PrImportTargetPicker";
import { ReviewThreadCard, type SuggestionApply } from "./ReviewThreads";
import { usePrDiffContext } from "./usePrDiffContext";
import {
  type PrFileHistory,
  type PrFileVisit,
  usePrFileHistory,
} from "./usePrFileHistory";
import { usePrImportNavigation } from "./usePrImportNavigation";

type PrFile = { path: string; additions: number; deletions: number };
const PrSourceFile = lazy(() =>
  import("./PrSourceFile").then((module) => ({ default: module.PrSourceFile })),
);
const PrFullFileDiff = lazy(() =>
  import("./PrFullFileDiff").then((module) => ({
    default: module.PrFullFileDiff,
  })),
);

type PrFileView =
  | {
      kind: "diff";
      path: string;
      headSha: string | null;
      lens: RemoteLens;
      number: number | undefined;
    }
  | {
      kind: "source";
      path: string;
      headSha: string;
      lens: RemoteLens;
      statusLabel: string;
    }
  | {
      kind: "full";
      path: string;
      headSha: string;
      lens: RemoteLens;
      number: number;
    };

function subscribeLineComposer(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-diff-line-widget"],
  });
  return () => observer.disconnect();
}

const ignoreSlotRead = () => undefined;

type PrImportWiring = {
  onOpenImport?: ComponentProps<typeof PrCodeImportLinks>["onOpen"];
  getImportSource?: ComponentProps<typeof PrCodeImportLinks>["getSource"];
  importDisabled?: boolean;
};

/** The handlers/gates the in-diff {@link ReviewThreadCard}s need — a subset of
 *  the Conversation block's, passed straight through from the view. */
interface DiffThreadWiring {
  onQuote?: (body: string) => void;
  onReply?: (threadId: string, body: string) => Promise<void>;
  onResolve?: (threadId: string, resolved: boolean) => Promise<void>;
  /** Replies and resolves in flight per thread, from the mutation cache. */
  pendingWrites?: PendingThreadWrites;
  /** The forge the threads came from — disambiguates bare-fence Apply scope for
   *  suggestions (GitHub = whole range, GitLab = anchored line only). Defaults to
   *  "github" in the card so an unwired caller is byte-identical. */
  provider?: ForgeProvider;
  /** Gating inputs + the write for the per-suggestion Apply affordance. Absent =
   *  no Apply shown (identical graceful default as the Conversation block). */
  apply?: SuggestionApply;
  /** File-section lookup for synthesizing a hunk on hunk-less providers, so the
   *  in-diff thread cards get the same Apply affordance. Absent = no synthesis. */
  fileDiffLookup?: (path: string) => string | undefined;
  /** Opt in to `@`/`#`/`!` autocomplete in each card's editors. Absent = no
   *  autocomplete. */
  mentions?: MentionSource;
}

/**
 * One anchor block: the review thread(s) on a single side+line, rendered as a
 * gap-2 stack of compact {@link ReviewThreadCard}s. Owns its own per-thread
 * expanded state (unresolved default-open, resolved default-closed) so each
 * card collapses independently, mirroring the Conversation block's defaults.
 */
function DiffThreadAnchor({
  threads,
  onQuote,
  onReply,
  onResolve,
  pendingWrites,
  provider,
  apply,
  fileDiffLookup,
  mentions,
}: { threads: ReviewThreadOut[] } & DiffThreadWiring) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const isExpanded = (t: ReviewThreadOut) => expanded[t.id] ?? !t.isResolved;
  return (
    <div className="flex flex-col gap-2">
      {threads.map((t) => (
        <ReviewThreadCard
          key={t.id}
          thread={t}
          compact
          expanded={isExpanded(t)}
          onToggleExpand={() =>
            setExpanded((prev) => ({
              ...prev,
              [t.id]: !(prev[t.id] ?? !t.isResolved),
            }))
          }
          onQuote={onQuote}
          onReply={onReply}
          onResolve={onResolve}
          pendingWrites={pendingWrites}
          provider={provider}
          apply={apply}
          fileDiffLookup={fileDiffLookup}
          mentions={mentions}
        />
      ))}
    </div>
  );
}

/** The "Files" sub-tab: a file list down the left, the selected file's diff on
 *  the right. Presentational — the parent owns the selection + diff query.
 *  Review threads anchored to the selected file render under their exact line. */
export function PrFilesPane({
  files,
  binaryPaths,
  effectivePath,
  onSelectPath,
  fileDiff,
  isPending,
  isError,
  isPaused,
  isFetching,
  onRetry,
  dataIsPlaceholder,
  threads,
  drafts,
  repoPath,
  lens,
  number,
  lineWidget,
  onQuote,
  onReply,
  onResolve,
  pendingWrites,
  provider,
  apply,
  fileDiffLookup,
  mentions,
  blameRev,
  changesIncomplete = false,
  interactionEnabled = true,
  fileHistory,
}: {
  files: PrFile[];
  /** Rows to show as binary (`binaryRowPaths`: 0/0 forge counts over a marker
   *  section); absent/empty = no rows flagged. */
  binaryPaths?: ReadonlySet<string>;
  effectivePath: string | null;
  onSelectPath: (path: string) => void;
  fileDiff: ComponentProps<typeof DiffContent>["data"];
  isPending: boolean;
  isError: boolean;
  isPaused?: boolean;
  /** The diff read has a fetch in flight; over `isError` it hasn't settled. */
  isFetching: boolean;
  onRetry?: () => void;
  dataIsPlaceholder?: boolean;
  /** All PR review threads; the pane anchors those on the selected file. */
  threads?: ReviewThreadOut[];
  /** Pending-review drafts; those on the selected file render as anchored cards
   *  under their line (needs `repoPath`/`lens`/`number` for the edit/delete writes). */
  drafts?: ReviewDraft[];
  repoPath?: string;
  /** The origin|upstream lens the parent PR view resolved — part of the draft
   *  store's key, so the cards can't edit the other lens's same-numbered PR. */
  lens?: RemoteLens;
  number?: number;
  /** The inline line-comment composer, passed straight to the diff. Absent =
   *  a read-only diff (unchanged). */
  lineWidget?: LineWidget;
  /** PR head sha — pins the file-row Blame at the PR's tip. Omit to hide Blame. */
  blameRev?: string;
  /** An incomplete MR file list cannot classify other paths as unchanged. */
  changesIncomplete?: boolean;
  /** The parent is showing this request's settled, interactive details. */
  interactionEnabled?: boolean;
  /** Owned above the Files section so visits and scope survive its remount. */
  fileHistory?: PrFileHistory;
} & DiffThreadWiring) {
  const diffEntity = `${lens ?? ""}#${number ?? ""}`;
  const scopeKey = JSON.stringify([repoPath, diffEntity, blameRev ?? null]);
  const ownHistory = usePrFileHistory(
    scopeKey,
    effectivePath,
    interactionEnabled && fileHistory === undefined,
  );
  const history = fileHistory ?? ownHistory;
  const restoreVisit =
    history.current?.kind === "source" ||
    history.previous !== null ||
    history.next !== null
      ? history.current
      : null;
  const [treeReveal, setTreeReveal] = useState<{
    key: string;
    path: string;
    id: number;
    active: boolean;
  } | null>(() =>
    restoreVisit
      ? { key: scopeKey, path: restoreVisit.path, id: 1, active: true }
      : null,
  );
  if (treeReveal !== null && treeReveal.key !== scopeKey)
    setTreeReveal(
      restoreVisit
        ? {
            key: scopeKey,
            path: restoreVisit.path,
            id: treeReveal.id + 1,
            active: true,
          }
        : { ...treeReveal, key: scopeKey, active: false },
    );
  const [emptyScope, setEmptyScope] = useState({
    key: scopeKey,
    allFiles: false,
  });
  const scope = {
    allFiles:
      history.current?.allFiles ??
      (emptyScope.key === scopeKey && emptyScope.allFiles),
    sourcePath:
      history.current?.kind === "source" && blameRev
        ? { path: history.current.path, headSha: blameRev }
        : null,
  };
  const fileViewKey = JSON.stringify([
    scopeKey,
    blameRev,
    provider,
    effectivePath,
    scope.sourcePath?.path ?? null,
  ]);
  const [fileView, setFileView] = useState({
    key: fileViewKey,
    full: false,
  });
  if (fileView.key !== fileViewKey)
    setFileView({ key: fileViewKey, full: false });
  const fullFile = fileView.key === fileViewKey && fileView.full;
  const composerOpen = useSyncExternalStore(
    subscribeLineComposer,
    lineComposerOpen,
  );
  const snapshotReady =
    !!repoPath &&
    number !== undefined &&
    number > 0 &&
    !!blameRev &&
    FULL_OID_RE.test(blameRev);
  const snapshot = usePrSnapshotFiles(
    repoPath ?? "",
    number ?? 0,
    blameRev,
    lens ?? "origin",
    (scope.allFiles || fullFile) && snapshotReady,
  );
  const changedPaths = useMemo(
    () => new Set(files.map((file) => file.path)),
    [files],
  );
  const sourcePaths = useMemo(
    () =>
      new Set(
        snapshot.data
          ?.filter((file) => !file.undecodable)
          .map((file) => file.path),
      ),
    [snapshot.data],
  );
  const treeFiles = useMemo<PrTreeFile[]>(() => {
    if (!scope.allFiles || !snapshot.data) return files;
    return [
      ...files,
      ...snapshot.data
        .filter((file) => file.undecodable || !changedPaths.has(file.path))
        .map((file, index) => ({
          path: file.path,
          sourceOnly: true as const,
          undecodable: file.undecodable,
          entryId: file.undecodable ? String(index) : undefined,
        })),
    ];
  }, [files, scope.allFiles, snapshot.data, changedPaths]);
  const sourcePath =
    scope.allFiles &&
    scope.sourcePath !== null &&
    scope.sourcePath.headSha === blameRev &&
    (snapshot.data === undefined || sourcePaths.has(scope.sourcePath.path)) &&
    !changedPaths.has(scope.sourcePath.path)
      ? scope.sourcePath
      : null;
  const shownPath = sourcePath?.path ?? effectivePath;
  const showFileViewToggle =
    shownPath !== null && sourcePath === null && changedPaths.has(shownPath);
  const comparisonSupported =
    provider === "gitlab" && (lens ?? "origin") === "origin";
  const interactionReason = "Wait for the selected request to finish opening.";
  const fullFileReason = !interactionEnabled
    ? interactionReason
    : !comparisonSupported
      ? "Full file comparison is available for GitLab merge requests on origin."
      : !snapshotReady
        ? "Reload this request to read the file at its head commit."
        : composerOpen
          ? LAYOUT_COMPOSER_HELD
          : undefined;
  function toggleFileScope() {
    if (
      !interactionEnabled ||
      lineComposerOpen() ||
      (!snapshotReady && !scope.allFiles)
    )
      return;
    useUiStore.getState().noteUserInteraction();
    const path =
      scope.allFiles && scope.sourcePath
        ? (effectivePath ?? scope.sourcePath.path)
        : (shownPath ?? history.current?.path);
    if (path)
      history.visit({ path, kind: "change", allFiles: !scope.allFiles });
    else setEmptyScope({ key: scopeKey, allFiles: !scope.allFiles });
  }
  function setFileMode(full: boolean) {
    if (!interactionEnabled) return;
    if (full && (!snapshotReady || !comparisonSupported || lineComposerOpen()))
      return;
    useUiStore.getState().noteUserInteraction();
    setFileView({ key: fileViewKey, full });
  }
  useHotkeyAction(
    "pr-toggle-all-files",
    toggleFileScope,
    interactionEnabled && !composerOpen && (snapshotReady || scope.allFiles),
  );
  useHotkeyAction(
    "pr-toggle-full-file",
    () => setFileMode(!fullFile),
    interactionEnabled &&
      showFileViewToggle &&
      (fullFile || fullFileReason === undefined),
  );
  const sourceLabel = changesIncomplete ? "Not in loaded changes" : "Unchanged";
  function revealFile(path: string) {
    setTreeReveal((previous) => ({
      key: scopeKey,
      path,
      id: (previous?.id ?? 0) + 1,
      active: true,
    }));
  }
  function navigateFile(
    visit: PrFileVisit,
    options?: { record?: false; reveal?: false },
  ) {
    if (!interactionEnabled || lineComposerOpen()) return;
    useUiStore.getState().noteUserInteraction();
    if (options?.record !== false) history.visit(visit);
    if (visit.kind === "change") onSelectPath(visit.path);
    if (options?.reveal !== false) revealFile(visit.path);
    else
      setTreeReveal((previous) =>
        previous?.active ? { ...previous, active: false } : previous,
      );
  }
  const selectFile = (path: string) =>
    navigateFile(
      {
        path,
        kind:
          scope.allFiles && sourcePaths.has(path) && !changedPaths.has(path)
            ? "source"
            : "change",
        allFiles: scope.allFiles,
      },
      // The tree owns its row focus; an external reveal would clear that intent.
      { reveal: false },
    );
  function selectChangedFile(path: string) {
    navigateFile({ path, kind: "change", allFiles: scope.allFiles });
  }
  function moveFileHistory(direction: "back" | "forward") {
    if (!interactionEnabled || lineComposerOpen()) return;
    const visit = direction === "back" ? history.back() : history.forward();
    if (visit) navigateFile(visit, { record: false });
  }
  const historyHeldReason = !interactionEnabled
    ? interactionReason
    : composerOpen
      ? LAYOUT_COMPOSER_HELD
      : undefined;
  useHotkeyAction(
    "pr-file-back",
    () => moveFileHistory("back"),
    historyHeldReason === undefined && history.previous !== null,
  );
  useHotkeyAction(
    "pr-file-forward",
    () => moveFileHistory("forward"),
    historyHeldReason === undefined && history.next !== null,
  );
  const changesLabel = provider === "gitlab" ? "MR changes" : "PR changes";
  // Markdown preview reads the file at the PR head, so it's offered only once
  // that commit is a local object (after a Check out PR or a fetch).
  const headPresent = useObjectsPresent(
    repoPath ?? null,
    blameRev ? [blameRev] : [],
  );
  const previewRev =
    repoPath && blameRev && headPresent.data === true ? blameRev : undefined;
  // The file's diff swaps through the pane's two-slot hold, within this pull
  // request; another one re-targets the shown slot in place.
  const view: PrFileView | null = shownPath
    ? sourcePath
      ? {
          kind: "source",
          path: sourcePath.path,
          headSha: sourcePath.headSha,
          lens: lens ?? "origin",
          statusLabel: changesIncomplete
            ? "Not in loaded changes"
            : "No MR changes",
        }
      : fullFile && snapshotReady && blameRev && number !== undefined
        ? {
            kind: "full",
            path: shownPath,
            headSha: blameRev,
            lens: lens ?? "origin",
            number,
          }
        : {
            kind: "diff",
            path: shownPath,
            headSha: blameRev ?? null,
            lens: lens ?? "origin",
            number,
          }
    : null;
  const diffTarget = view
    ? keyedPaneView(repoPath ?? "", diffEntity, JSON.stringify(view), view)
    : placeholderPaneView(diffEntity);
  const diffSlots = useFileSlots(diffTarget);
  const contentRef = useRef<HTMLDivElement>(null);
  const importDisabled =
    !interactionEnabled ||
    !snapshotReady ||
    diffSlots.holding ||
    diffSlots.read.loading ||
    diffSlots.read.placeholder;
  const importLinks = usePrImportNavigation({
    repoPath: repoPath ?? "",
    number: number ?? 0,
    lens: lens ?? "origin",
    headSha: blameRev ?? "",
    path: shownPath,
    enabled: !importDisabled,
    comparisonSupported,
    onNavigate: (target) => {
      navigateFile({
        path: target,
        kind: changedPaths.has(target) ? "change" : "source",
        allFiles: !changedPaths.has(target) || scope.allFiles,
      });
    },
  });

  return (
    <DetailRailRow>
      <PrFilesTree
        key={`${repoPath ?? ""}:${lens ?? ""}:${number ?? ""}`}
        files={treeFiles}
        binaryPaths={binaryPaths}
        effectivePath={shownPath}
        revealRequest={
          treeReveal?.active &&
          treeReveal.key === scopeKey &&
          treeFiles.some(
            (file) =>
              file.path === treeReveal.path &&
              !(file.sourceOnly && file.undecodable),
          )
            ? treeReveal
            : undefined
        }
        onSelectPath={selectFile}
        repoPath={repoPath}
        blameRev={blameRev}
        allFiles={scope.allFiles}
        sourceLabel={sourceLabel}
        header={
          <div className="flex min-w-0 flex-1 items-center gap-0.5">
            <DisabledReasonButton
              variant={scope.allFiles ? "secondary" : "ghost"}
              size="icon-xs"
              aria-label={`File scope: ${scope.allFiles ? "All files" : changesLabel}`}
              aria-pressed={scope.allFiles}
              title={`${scope.allFiles ? "All files" : changesLabel} · ${scope.allFiles ? `Show ${changesLabel}` : "Show all files"}`}
              disabled={
                !interactionEnabled ||
                composerOpen ||
                (!snapshotReady && !scope.allFiles)
              }
              reason={
                !interactionEnabled
                  ? interactionReason
                  : composerOpen
                    ? LAYOUT_COMPOSER_HELD
                    : !snapshotReady
                      ? "Reload this request to read its complete commit version."
                      : undefined
              }
              onClick={toggleFileScope}
            >
              <FilesIcon
                aria-hidden
                weight={scope.allFiles ? "fill" : "regular"}
              />
            </DisabledReasonButton>
            <span className="ml-auto inline-flex items-center gap-1">
              <span
                role="group"
                aria-label="File history navigation"
                className="inline-flex shrink-0 items-center gap-1"
              >
                <DisabledReasonButton
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Back in file history"
                  title="Back in file history"
                  disabled={
                    historyHeldReason !== undefined || history.previous === null
                  }
                  reason={
                    historyHeldReason ??
                    (history.previous === null
                      ? "No earlier file in this request's history."
                      : undefined)
                  }
                  onClick={() => moveFileHistory("back")}
                >
                  <ArrowLeftIcon aria-hidden />
                </DisabledReasonButton>
                <DisabledReasonButton
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Forward in file history"
                  title="Forward in file history"
                  disabled={
                    historyHeldReason !== undefined || history.next === null
                  }
                  reason={
                    historyHeldReason ??
                    (history.next === null
                      ? "No later file in this request's history."
                      : undefined)
                  }
                  onClick={() => moveFileHistory("forward")}
                >
                  <ArrowRightIcon aria-hidden />
                </DisabledReasonButton>
              </span>
              <PrChangedFilesNav
                files={files}
                treeFiles={treeFiles}
                currentPath={shownPath}
                onSelectPath={selectChangedFile}
                disabled={!interactionEnabled || composerOpen}
              />
            </span>
          </div>
        }
        notice={
          scope.allFiles && snapshot.data === undefined ? (
            <div
              role="status"
              className="shrink-0 border-b px-3 py-2 text-xs text-muted-foreground"
            >
              {snapshot.isError ? (
                <>
                  <p>Couldn't load all files.</p>
                  <Button
                    variant="ghost"
                    size="xs"
                    aria-label="Retry loading all files"
                    onClick={() => void snapshot.refetch()}
                  >
                    Retry
                  </Button>
                </>
              ) : snapshot.isPaused ? (
                "All files will load when you're back online."
              ) : (
                <span className="flex items-center gap-1.5">
                  <Spinner className="size-3" />
                  Loading all files…
                </span>
              )}
            </div>
          ) : undefined
        }
      />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {showFileViewToggle && (
          <div className="flex min-w-0 shrink-0 items-center gap-2 border-b px-3 py-0.5">
            {fullFile && (
              <span
                title="Before: MR base · After: MR head"
                className="min-w-0 truncate text-xs text-muted-foreground"
              >
                Before: MR base · After: MR head
              </span>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <PrChangesNav
                key={diffTarget.kind === "file" ? diffTarget.key : "empty"}
                contentRef={contentRef}
                disabled={
                  !interactionEnabled ||
                  diffSlots.holding ||
                  diffSlots.read.loading ||
                  diffSlots.read.placeholder
                }
              />
              <ButtonGroup aria-label="File view">
                <DisabledReasonButton
                  variant={fullFile ? "ghost" : "secondary"}
                  size="xs"
                  aria-pressed={!fullFile}
                  disabled={!interactionEnabled}
                  reason={interactionReason}
                  onClick={() => setFileMode(false)}
                >
                  Diff
                </DisabledReasonButton>
                <DisabledReasonButton
                  variant={fullFile ? "secondary" : "ghost"}
                  size="xs"
                  aria-pressed={fullFile}
                  disabled={fullFileReason !== undefined}
                  reason={fullFileReason}
                  onClick={() => setFileMode(true)}
                >
                  Full file
                </DisabledReasonButton>
              </ButtonGroup>
            </div>
          </div>
        )}
        <div ref={contentRef} className="min-h-0 flex-1">
          <FileSlots
            slots={diffSlots}
            target={diffTarget}
            busy={diffSlots.holding || diffSlots.read.loading}
          >
            {(view) =>
              view.kind === "file" ? (
                view.file.kind === "full" ? (
                  <PrFullFileSlot
                    repoPath={view.repo}
                    view={view.file}
                    reportRead={diffSlots.reportRead}
                    onRetry={onRetry}
                    onOpenImport={importLinks.onOpen}
                    importDisabled={importDisabled}
                  />
                ) : view.file.kind === "source" ? (
                  snapshot.data === undefined &&
                  view.repo === repoPath &&
                  view.file.headSha === blameRev &&
                  view.file.lens === (lens ?? "origin") ? (
                    <SourceHeadPreparation
                      path={view.file.path}
                      pending={snapshot.isPending}
                      paused={snapshot.isPaused}
                      error={snapshot.isError}
                    />
                  ) : (
                    <Suspense
                      fallback={<DiffPlaceholder message="Loading file…" />}
                    >
                      <PrSourceFile
                        repoPath={view.repo}
                        path={view.file.path}
                        headSha={view.file.headSha}
                        lens={view.file.lens}
                        statusLabel={view.file.statusLabel}
                        reportRead={diffSlots.reportRead}
                        onOpenImport={importLinks.onOpen}
                        importDisabled={importDisabled}
                      />
                    </Suspense>
                  )
                ) : (
                  <PrFileDiffSlot
                    path={view.file.path}
                    entity={view.entity}
                    fileDiff={fileDiff}
                    isPending={isPending}
                    isError={isError}
                    isPaused={isPaused}
                    isFetching={isFetching}
                    onRetry={onRetry}
                    dataIsPlaceholder={dataIsPlaceholder}
                    threads={threads}
                    drafts={drafts}
                    repoPath={view.repo}
                    lens={view.file.lens}
                    number={view.file.number}
                    previewRev={previewRev}
                    anchorCommit={view.file.headSha}
                    contextEnabled={comparisonSupported && interactionEnabled}
                    composerOpen={composerOpen}
                    lineWidget={lineWidget}
                    onQuote={onQuote}
                    onReply={onReply}
                    onResolve={onResolve}
                    pendingWrites={pendingWrites}
                    provider={provider}
                    apply={apply}
                    fileDiffLookup={fileDiffLookup}
                    mentions={mentions}
                    reportRead={diffSlots.reportRead}
                    onOpenImport={importLinks.onOpen}
                    getImportSource={importLinks.getSource}
                    importDisabled={importDisabled}
                  />
                )
              ) : (
                <DiffPlaceholder message="Select a file to see its changes" />
              )
            }
          </FileSlots>
        </div>
      </main>
      {importLinks.choices && (
        <PrImportTargetPicker
          key={importLinks.choices.request}
          specifier={importLinks.choices.specifier}
          paths={importLinks.choices.paths}
          onChoose={importLinks.chooseTarget}
          onClose={importLinks.dismissChoices}
        />
      )}
    </DetailRailRow>
  );
}

function FullFileLoading({
  path,
  message = "Preparing the MR head…",
}: {
  path: string;
  message?: string;
}) {
  useReportPaneSettled(false);
  return <PrFullFileLoading filePath={path} message={message} />;
}

function FullFileReadGate({ settled }: { settled: boolean }) {
  useReportPaneSettled(settled);
  return null;
}

/** A restored source waits for its exact head tree instead of reading the
 *  underlying changed selection while the file-list cache is cold. */
function SourceHeadPreparation({
  path,
  pending,
  paused,
  error,
}: {
  path: string;
  pending: boolean;
  paused: boolean;
  error: boolean;
}) {
  useReportPaneSettled(!pending || paused);
  if (error)
    return (
      <DiffPlaceholder message="Could not prepare this MR file. Retry loading all files." />
    );
  if (paused)
    return <DiffPlaceholder message={offlinePendingMessage("this file")} />;
  return <PrFullFileLoading filePath={path} message="Preparing the MR head…" />;
}

/** Each slot prepares its own captured head; a held source never follows the
 *  newly selected file's repository, MR, or lens. */
function PrFullFileSlot({
  repoPath,
  view,
  reportRead,
  onRetry,
  onOpenImport,
  importDisabled,
}: {
  repoPath: string;
  view: Extract<PrFileView, { kind: "full" }>;
  reportRead: (read: SlotRead) => void;
  onRetry?: () => void;
} & PrImportWiring) {
  const snapshot = usePrSnapshotFiles(
    repoPath,
    view.number,
    view.headSha,
    view.lens,
    true,
  );
  const sourceReady =
    !snapshot.isPlaceholderData && Array.isArray(snapshot.data);
  // The comparison child owns busy state once its paired read mounts.
  useSlotRead(sourceReady ? ignoreSlotRead : reportRead, {
    isPlaceholderData: snapshot.isPlaceholderData,
    isPending: snapshot.isPending,
    isPaused: snapshot.isPaused,
  });
  const pane = resolveDetailPane({
    pending: snapshot.isPending,
    error: snapshot.isError,
    hasData: snapshot.data !== undefined,
    paused: snapshot.isPaused,
    fetching: snapshot.isFetching,
  });
  const failed = refreshFailed(snapshot);
  const { hostRef, retryRef } = useRetryFocusRescue(pane === "error");

  let body;
  if (pane === "offline") {
    body = <DiffPlaceholder message={offlinePendingMessage("this file")} />;
  } else if (pane === "skeleton") {
    body = <FullFileLoading path={view.path} />;
  } else if (pane === "error") {
    body = (
      <DiffPlaceholder
        message="Could not prepare this MR head"
        action={
          <div className="flex max-w-md flex-col items-center gap-2 px-4 text-center text-xs">
            <p>{presentError(snapshot.error).summary}</p>
            <Button
              ref={retryRef}
              variant="outline"
              size="sm"
              aria-label="Retry loading full file"
              onClick={() => {
                onRetry?.();
                void snapshot.refetch();
              }}
            >
              Retry
            </Button>
          </div>
        }
      />
    );
  } else if (!sourceReady) {
    body = (
      <DiffPlaceholder message="Could not verify the MR head. Reload this request or use Diff." />
    );
  } else {
    body = (
      <Suspense
        fallback={
          <FullFileLoading
            path={view.path}
            message="Loading full comparison…"
          />
        }
      >
        <PrFullFileDiff
          repoPath={repoPath}
          number={view.number}
          headSha={view.headSha}
          path={view.path}
          lens={view.lens}
          reportRead={reportRead}
          onRetry={onRetry}
          onOpenImport={onOpenImport}
          importDisabled={importDisabled}
        />
      </Suspense>
    );
  }
  return (
    <div
      ref={hostRef}
      tabIndex={-1}
      className="flex h-full min-h-0 flex-col outline-none"
    >
      {!sourceReady && (
        <FullFileReadGate
          settled={
            (!snapshot.isPending || snapshot.isPaused) &&
            !snapshot.isPlaceholderData
          }
        />
      )}
      <DegradedListNotice
        noun="MR head"
        degraded={pane === "content-degraded"}
        message={detailNoticeMessage({
          noun: "MR head",
          isError: failed,
          stale: snapshot.isPlaceholderData,
        })}
        onRetry={
          failed
            ? () => {
                onRetry?.();
                void snapshot.refetch();
              }
            : undefined
        }
        className="border-b px-3 py-1.5"
      />
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );
}

/** One file's diff in the Files pane's slot: its section of the pull request's
 *  patch, and the threads and drafts anchored to it, so a held file never shows
 *  the next one's. */
function PrFileDiffSlot({
  path,
  entity,
  fileDiff,
  isPending,
  isError,
  isPaused,
  isFetching,
  onRetry,
  dataIsPlaceholder,
  threads,
  drafts,
  repoPath,
  lens,
  number,
  previewRev,
  anchorCommit,
  lineWidget,
  onQuote,
  onReply,
  onResolve,
  pendingWrites,
  provider,
  apply,
  fileDiffLookup,
  mentions,
  reportRead,
  onOpenImport,
  getImportSource,
  importDisabled,
  contextEnabled,
  composerOpen,
}: {
  path: string;
  /** The pull request (lens and number) this slot's view belongs to. */
  entity: string;
  /** The parent's diff for ITS selected file; absent with no patch loaded. */
  fileDiff: ComponentProps<typeof DiffContent>["data"];
  isPending: boolean;
  isError: boolean;
  isPaused?: boolean;
  isFetching: boolean;
  onRetry?: () => void;
  dataIsPlaceholder?: boolean;
  threads?: ReviewThreadOut[];
  drafts?: ReviewDraft[];
  repoPath?: string;
  lens?: RemoteLens;
  number?: number;
  previewRev?: string;
  /** The pull request's head, gating the binary-size lookups. */
  anchorCommit?: string | null;
  contextEnabled: boolean;
  composerOpen: boolean;
  /** The parent's composer, for its selected file: only a shown slot opens it. */
  lineWidget?: LineWidget;
  reportRead: (read: SlotRead) => void;
} & DiffThreadWiring &
  PrImportWiring) {
  useSlotRead(reportRead, {
    isPlaceholderData: dataIsPlaceholder ?? false,
    isPending,
    isPaused,
  });
  // The parent builds the diff of its selected file; a held slot's file is
  // another section of the same in-memory patch, or failing a lookup, the diff
  // it showed for this file of this pull request. A slot with no diff of its
  // own shows its read's pending or failed state, never another file's.
  const own =
    fileDiff !== undefined && fileDiff.filePath === path ? fileDiff : undefined;
  const shown = useSlotRetained(
    entity,
    path,
    dataIsPlaceholder ? undefined : own,
  );
  const section =
    fileDiff !== undefined && own === undefined
      ? fileDiffLookup?.(path)
      : undefined;
  const data =
    own ??
    (section !== undefined
      ? {
          filePath: path,
          text: section,
          isBinary: sectionIsBinary(section),
          isTruncated: false,
        }
      : shown);

  // Anchors for THIS slot's file only: threads (with a known line, not outdated)
  // AND pending-review drafts on this path. Multiple items on the same side+line
  // collapse into ONE stacked anchor (the diff library keeps a single render per
  // side+line — last write wins — so threads + a draft here must share it).
  const lineAnchors = useMemo<DiffLineAnchor[]>(() => {
    const threadsBySideLine = new Map<string, ReviewThreadOut[]>();
    for (const t of threads ?? []) {
      if (t.path !== path || t.line <= 0 || t.isOutdated) continue;
      const side = t.side === "old" ? "old" : "new";
      const key = `${side}:${t.line}`;
      const bucket = threadsBySideLine.get(key);
      if (bucket) bucket.push(t);
      else threadsBySideLine.set(key, [t]);
    }
    const draftsBySideLine = new Map<string, ReviewDraft[]>();
    // Drafts only render when the store owner keys (repoPath/lens/number) are present.
    if (repoPath !== undefined && lens !== undefined && number !== undefined) {
      for (const d of drafts ?? []) {
        if (d.path !== path || d.line <= 0) continue;
        const key = `${d.side}:${d.line}`;
        const bucket = draftsBySideLine.get(key);
        if (bucket) bucket.push(d);
        else draftsBySideLine.set(key, [d]);
      }
    }
    const keys = new Set([
      ...threadsBySideLine.keys(),
      ...draftsBySideLine.keys(),
    ]);
    return [...keys].map((key) => {
      const [side, line] = key.split(":");
      const threadGroup = threadsBySideLine.get(key) ?? [];
      const draftGroup = draftsBySideLine.get(key) ?? [];
      return {
        side: side as "old" | "new",
        line: Number(line),
        render: () => (
          <div className="flex flex-col gap-2">
            {threadGroup.length > 0 && (
              <DiffThreadAnchor
                threads={threadGroup}
                onQuote={onQuote}
                onReply={onReply}
                onResolve={onResolve}
                pendingWrites={pendingWrites}
                provider={provider}
                apply={apply}
                fileDiffLookup={fileDiffLookup}
                mentions={mentions}
              />
            )}
            {repoPath !== undefined &&
              lens !== undefined &&
              number !== undefined &&
              draftGroup.map((d) => (
                <DraftCommentCard
                  key={d.id}
                  repoPath={repoPath}
                  lens={lens}
                  number={number}
                  draft={d}
                />
              ))}
          </div>
        ),
      };
    });
  }, [
    path,
    threads,
    drafts,
    repoPath,
    lens,
    number,
    onQuote,
    onReply,
    onResolve,
    pendingWrites,
    provider,
    apply,
    fileDiffLookup,
    mentions,
  ]);

  const widget = useSlotWidget(lineWidget);
  const diffContext = usePrDiffContext({
    repoPath,
    number,
    headSha: anchorCommit,
    lens: lens ?? "origin",
    path,
    data,
    enabled: contextEnabled && !dataIsPlaceholder && !isPending,
    composerOpen,
  });
  const renderData = useMemo(
    () => (data && diffContext ? { ...data, text: diffContext.patch } : data),
    [data, diffContext],
  );
  const content = (
    <DiffContent
      filePath={path}
      data={renderData}
      isPending={isPending}
      isError={isError}
      isPaused={isPaused}
      isFetching={isFetching}
      onRetry={onRetry}
      dataIsPlaceholder={dataIsPlaceholder}
      repoPath={repoPath}
      previewRev={previewRev}
      anchorCommit={anchorCommit}
      fileContent={diffContext?.content}
      lineAnchors={lineAnchors}
      lineWidget={widget}
    />
  );
  return onOpenImport ? (
    <PrCodeImportLinks
      path={path}
      oldPath={
        data && !dataIsPlaceholder ? sectionOldFilePath(data.text) : undefined
      }
      onOpen={onOpenImport}
      getSource={getImportSource}
      disabled={importDisabled || dataIsPlaceholder}
    >
      {content}
    </PrCodeImportLinks>
  ) : (
    content
  );
}

/** Merge-confirm dialog. Presentational — the parent keeps the merge mutation
 *  (so its `busy` flag stays accurate) and passes `pending` + `onConfirm`. */
export function MergePrDialog({
  open,
  onClose,
  number,
  host,
  prNoun,
  headRefName,
  baseRefName,
  strategyLabel,
  deleteBranch,
  onDeleteBranchChange,
  headIsDefault,
  deletionBlocked,
  pending,
  heldReason,
  onConfirm,
  auto = false,
  stackNotice,
  confirmLabel,
}: {
  open: boolean;
  onClose: () => void;
  number: number;
  /** Provider name ("GitHub" / "GitLab" / "Bitbucket") — where the merge happens. */
  host: string;
  /** "pull request" / "merge request". */
  prNoun: string;
  headRefName: string;
  baseRefName: string;
  strategyLabel: string;
  deleteBranch: boolean;
  onDeleteBranchChange: (v: boolean) => void;
  /** Head is the repo's default branch — every forge refuses to delete it, so
   *  the delete-branch option is hidden entirely. */
  headIsDefault: boolean;
  /** A branch rule blocks deleting the head — the option shows but is disabled. */
  deletionBlocked: boolean;
  pending: boolean;
  /** Holds the confirm with this reason (offline) while the dialog stays open. */
  heldReason?: string;
  onConfirm: () => void;
  /** Arms merge-when-pipeline-succeeds instead of merging now (GitLab-only) —
   *  reframes the copy + confirm button; the delete-branch checkbox rides the arm. */
  auto?: boolean;
  /** Extra scope this merge takes with it, shown above the options. Absent =
   *  nothing extra to disclose: unstacked, a host whose stacked merges don't
   *  cascade, or nothing still open below. Present is usually a cascading stack,
   *  but can also be a hedge — that stack membership couldn't be confirmed. */
  stackNotice?: string;
  /** Overrides the confirm button's label so a stacked merge can name how many
   *  PRs it lands. Absent = the strategy label, unchanged. */
  confirmLabel?: string;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="pr-8">
            {auto ? "Auto-merge" : "Merge"} {prNoun} #{number}?
          </DialogTitle>
          <DialogDescription>
            {auto ? (
              <>
                {strategyLabel} when the pipeline passes — merges{" "}
                <span className="font-mono break-all">{headRefName}</span> into{" "}
                <span className="font-mono break-all">{baseRefName}</span> on{" "}
                {host} once the running pipeline succeeds. This cannot be easily
                undone once it merges.
              </>
            ) : (
              <>
                {strategyLabel} — merges{" "}
                <span className="font-mono break-all">{headRefName}</span> into{" "}
                <span className="font-mono break-all">{baseRefName}</span> on{" "}
                {host}. This cannot be easily undone.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        {/* A stacked merge lands more than the PR on screen — say so above the
            options, never only on the confirm button. */}
        {stackNotice && <p className="text-xs text-warning">{stackNotice}</p>}
        {/* Deleting the head after merge is offered only when it's actually
            possible: never for the default branch (hidden — the forge refuses),
            and disabled with a reason when a branch rule blocks its deletion. */}
        {!headIsDefault && (
          <label
            className={cn(
              "flex items-start gap-2 text-xs text-muted-foreground",
              deletionBlocked
                ? "cursor-not-allowed opacity-70"
                : "cursor-pointer",
            )}
          >
            <Checkbox
              checked={deleteBranch && !deletionBlocked}
              disabled={deletionBlocked}
              onCheckedChange={(checked) =>
                onDeleteBranchChange(checked === true)
              }
            />
            <span className="min-w-0">
              Delete <span className="font-mono break-all">{headRefName}</span>{" "}
              on the remote after merging
              {deletionBlocked && (
                <span className="text-warning">
                  {" "}
                  — protected by a branch rule
                </span>
              )}
            </span>
          </label>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {/* The running write outranks the hold, and having its own reason keeps
              the button aria-disabled through either flip. */}
          <DisabledReasonButton
            disabled={pending || heldReason !== undefined}
            reason={pending ? ACT_PENDING_REASON : heldReason}
            onClick={onConfirm}
          >
            {pending && <Spinner data-icon="inline-start" />}
            {auto ? "Enable auto-merge" : (confirmLabel ?? strategyLabel)}
          </DisabledReasonButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The GitLab-only MR time-tracking summary for the header meta area: a compact
 * "Xh est · Ym spent" (zero parts omitted). For an OPEN MR it's a popover
 * trigger wrapping the same estimate/add-spent controls as the issue rail; for a
 * closed/merged MR it's a static line, and it renders nothing at all when there's
 * no time to show. GitHub is zero-diff — the caller only mounts this behind the
 * `timeTracking` flag.
 */
export function MrTimeTracking({
  repoPath,
  number,
  open,
  disabledReason,
  held = false,
}: {
  repoPath: string;
  number: number;
  /** Whether the MR is open — only then are the editing controls offered. */
  open: boolean;
  /** Set when the viewer lacks the access these edits need: the estimate and
   *  spent controls disable, with this text as their hint. The summary is a
   *  read and stays live. */
  disabledReason?: string;
  /** The view is holding this MR while another loads behind it. The view's
   *  `inert` can't reach the portaled popover, so this shuts it, and the writes
   *  refuse until the hold ends. */
  held?: boolean;
}) {
  const stats = useGlMrTimeStats(repoPath, number);
  const setEstimate = useSetMrTimeEstimate(repoPath);
  const addSpent = useAddMrSpentTime(repoPath);
  const [popoverOpen, setPopoverOpen] = useState(false);
  if (held && popoverOpen) setPopoverOpen(false);

  const data = stats.data;
  const humanEstimate = data?.humanTimeEstimate ?? "";
  const humanSpent = data?.humanTotalTimeSpent ?? "";
  const hasAny =
    (data?.timeEstimate ?? 0) > 0 || (data?.totalTimeSpent ?? 0) > 0;

  // Nothing to show and the MR is closed → render nothing (GitHub also lands
  // here via `hasAny` staying false, but the caller already gates on the flag).
  if (!hasAny && !open) return null;

  const summary = (
    <span className="flex items-center gap-1">
      <ClockIcon className="size-3 shrink-0" aria-hidden />
      {hasAny
        ? [
            humanEstimate ? `${humanEstimate} est` : null,
            humanSpent ? `${humanSpent} spent` : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : "Track time"}
    </span>
  );

  // Closed MR: a static, non-interactive summary.
  if (!open) {
    return (
      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
        {summary}
      </span>
    );
  }

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            aria-label="Time tracking"
          />
        }
      >
        {summary}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <p className="text-xs font-medium text-muted-foreground">
          Time tracking
        </p>
        {stats.isPending ? (
          <p className="text-[11px] text-muted-foreground">Loading…</p>
        ) : (
          <TimeTrackingControls
            stats={data}
            editable
            pending={setEstimate.isPending || addSpent.isPending}
            disabledReason={disabledReason}
            idPrefix="mr"
            onSetEstimate={(duration) => {
              if (!held) setEstimate.mutate({ number, duration });
            }}
            onAddSpent={(duration) => {
              if (!held) addSpent.mutate({ number, duration });
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
