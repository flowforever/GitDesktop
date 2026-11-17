import { useQuery } from "@tanstack/react-query";
import {
  type ComponentProps,
  lazy,
  type ReactNode,
  Suspense,
  useMemo,
  useState,
} from "react";
import { InfoNote } from "@/components/info-note";
import { LazyPanelFallback } from "@/components/lazy-panel-fallback";
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
import { useReportPaneSettled } from "@/features/diff/diff-pane-hold";
import { type SlotRead, useSlotRead } from "@/features/diff/file-slot";
import { HighlightedCode } from "@/features/diff/HighlightedCode";
import { presentError } from "@/lib/error-summary";
import type { FileBytes } from "@/lib/git/api";
import { FULL_OID_RE } from "@/lib/git/oid";
import { prSnapshotFileOptions } from "@/lib/git/queries/pr-snapshot";
import type { RemoteLens } from "@/lib/git/types";
import { isAppError } from "@/lib/tauri/invoke";
import { useIsDark } from "@/lib/use-is-dark";
import { PrCodeImportLinks } from "./PrCodeImportLinks";

const PrSourceEditor = lazy(() => import("./PrSourceEditor"));
const MAX_SOURCE_BYTES = 20_000_000;
const HIGHLIGHT_MAX_CHARS = 128_000;
const HIGHLIGHT_MAX_LINES = 2_000;
const RASTER_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

type SourceContent =
  | { kind: "absent" | "empty" | "binary" | "too-large" }
  | { kind: "image"; src: string }
  | { kind: "text"; text: string; large: boolean };

function exceedsHighlightLines(text: string): boolean {
  let from = 0;
  for (let line = 0; line < HIGHLIGHT_MAX_LINES; line++) {
    const newline = text.indexOf("\n", from);
    if (newline === -1) return false;
    from = newline + 1;
  }
  return from < text.length;
}

/** Native MIME null includes binary formats: only strict UTF-8 without NUL is
 *  source text. Images use the backend's sniffed raster allowlist alone. */
function sourceContent(data: FileBytes | null | undefined): SourceContent {
  if (data == null) return { kind: "absent" };
  const b64 = data.base64;
  if (
    data.tooLarge ||
    (data.size !== null && data.size > MAX_SOURCE_BYTES) ||
    (typeof b64 === "string" &&
      b64.length > Math.ceil(MAX_SOURCE_BYTES / 3) * 4)
  )
    return { kind: "too-large" };
  if (typeof b64 !== "string") return { kind: "binary" };
  if (data.mime !== null && RASTER_MIME.has(data.mime)) {
    return { kind: "image", src: `data:${data.mime};base64,${b64}` };
  }
  try {
    const binary = atob(b64);
    if (binary.length > MAX_SOURCE_BYTES) return { kind: "too-large" };
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (bytes.includes(0)) return { kind: "binary" };
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text === "") return { kind: "empty" };
    return {
      kind: "text",
      text,
      large: text.length > HIGHLIGHT_MAX_CHARS || exceedsHighlightLines(text),
    };
  } catch {
    return { kind: "binary" };
  }
}

/** An unchanged file at the MR's explicit head commit, without review actions
 *  or any working-tree fallback. The containing FileSlot owns its retention. */
export function PrSourceFile({
  repoPath,
  headSha,
  path,
  reportRead,
  lens = "origin",
  statusLabel = "No MR changes",
  onOpenImport,
  importDisabled,
}: {
  repoPath: string;
  headSha: string;
  path: string;
  reportRead: (read: SlotRead) => void;
  lens?: RemoteLens;
  statusLabel?: string;
  onOpenImport?: ComponentProps<typeof PrCodeImportLinks>["onOpen"];
  importDisabled?: boolean;
}) {
  const hasHead = FULL_OID_RE.test(headSha);
  const read = useQuery({
    ...prSnapshotFileOptions(repoPath, headSha, path, lens),
    enabled: hasHead,
  });
  useSlotRead(reportRead, {
    isPlaceholderData: read.isPlaceholderData,
    isPending: hasHead && read.isPending,
    isPaused: read.isPaused,
  });
  useReportPaneSettled(
    !hasHead || ((!read.isPending || read.isPaused) && !read.isPlaceholderData),
  );
  const content = useMemo(() => sourceContent(read.data), [read.data]);
  const pane = resolveDetailPane({
    pending: read.isPending,
    error: read.isError,
    hasData: read.data !== undefined,
    paused: read.isPaused,
    fetching: read.isFetching,
  });
  const failed = refreshFailed(read);
  const refused =
    isAppError(read.error) && read.error.kind === "invalidArgument";
  const retryShown = hasHead && pane === "error" && !refused;
  const { hostRef, retryRef } = useRetryFocusRescue(retryShown);

  let body: ReactNode;
  if (!hasHead) {
    body = <DiffPlaceholder message="MR head commit is unavailable." />;
  } else if (pane === "offline") {
    body = (
      <DiffPlaceholder message={offlinePendingMessage("this file's source")} />
    );
  } else if (pane === "skeleton") {
    body = <LazyPanelFallback name="file source" />;
  } else if (pane === "error") {
    body = (
      <DiffPlaceholder
        message="Could not load this file's source"
        action={
          <div className="flex max-w-md flex-col items-center gap-2 px-4 text-center text-xs">
            <p>{presentError(read.error).summary}</p>
            {!refused && (
              <Button
                ref={retryRef}
                variant="outline"
                size="sm"
                className="cursor-pointer"
                aria-label="Retry loading file source"
                onClick={() => void read.refetch()}
              >
                Retry
              </Button>
            )}
          </div>
        }
      />
    );
  } else {
    body = (
      <SourceBody
        key={JSON.stringify([repoPath, headSha, path])}
        path={path}
        content={content}
        importLinks={onOpenImport !== undefined}
      />
    );
    if (onOpenImport && content.kind === "text")
      body = (
        <PrCodeImportLinks
          path={path}
          onOpen={onOpenImport}
          disabled={importDisabled}
        >
          {body}
        </PrCodeImportLinks>
      );
  }

  return (
    <section
      ref={hostRef}
      tabIndex={-1}
      aria-label={`Source of ${path}`}
      className="ph-no-capture flex h-full min-h-0 flex-col outline-none"
    >
      <div className="flex min-w-0 shrink-0 items-center gap-3 border-b px-3 py-1.5">
        <div
          role="group"
          aria-label="File path"
          tabIndex={0}
          className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
        >
          {path}
        </div>
        <span className="shrink-0 text-[11px] whitespace-nowrap text-muted-foreground">
          {statusLabel}
        </span>
      </div>
      <DegradedListNotice
        noun="file source"
        degraded={hasHead && pane === "content-degraded"}
        message={detailNoticeMessage({
          noun: "file source",
          isError: failed,
          stale: read.isPlaceholderData,
        })}
        onRetry={failed ? () => void read.refetch() : undefined}
        className="border-b px-3 py-1.5"
      />
      <div className="min-h-0 flex-1">{body}</div>
    </section>
  );
}

function SourceBody({
  path,
  content,
  importLinks,
}: {
  path: string;
  content: SourceContent;
  importLinks: boolean;
}) {
  switch (content.kind) {
    case "absent":
      return <DiffPlaceholder message="File not present at this MR head." />;
    case "empty":
      return <DiffPlaceholder message="Empty file" />;
    case "binary":
      return (
        <DiffPlaceholder message="Binary file — source preview unavailable." />
      );
    case "too-large":
      return <DiffPlaceholder message="File too large to preview" />;
    case "image":
      return <SourceImage path={path} src={content.src} />;
    case "text":
      return content.large ? (
        <LargeSource
          path={path}
          text={content.text}
          importLinks={importLinks}
        />
      ) : (
        <div
          tabIndex={0}
          className="h-full overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
        >
          <HighlightedCode
            path={path}
            content={content.text}
            htmlFallback={importLinks}
          />
        </div>
      );
  }
}

function SourceImage({ path, src }: { path: string; src: string }) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  useReportPaneSettled(state !== "loading");
  if (state === "failed") {
    return <DiffPlaceholder message="Image could not be previewed." />;
  }
  return (
    <div className="flex h-full items-center justify-center overflow-auto p-4">
      <img
        alt={`${path} at MR head`}
        src={src}
        onLoad={() => setState("ready")}
        onError={() => setState("failed")}
        className="max-h-full max-w-full object-contain"
      />
    </div>
  );
}

function LargeSource({
  path,
  text,
  importLinks,
}: {
  path: string;
  text: string;
  importLinks: boolean;
}) {
  const isDark = useIsDark();
  const [ready, setReady] = useState(false);
  useReportPaneSettled(ready);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <InfoNote>Large file: syntax highlighting is disabled.</InfoNote>
      <div className="min-h-0 flex-1">
        <Suspense fallback={<LazyPanelFallback name="file source" />}>
          <PrSourceEditor
            path={path}
            text={text}
            importLinks={importLinks}
            isDark={isDark}
            onReady={() => setReady(true)}
          />
        </Suspense>
      </div>
    </div>
  );
}
