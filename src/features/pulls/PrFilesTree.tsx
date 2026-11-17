import {
  CaretDownIcon,
  CaretRightIcon,
  FileDashedIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
} from "@phosphor-icons/react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DetailRail } from "@/components/detail-rail";
import { DiffStat } from "@/components/diff-stat";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileRowActions } from "@/features/history/FileRowActions";
import { hasChordModifier } from "@/lib/hotkeys/binding";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import {
  flattenPathTree,
  type PathTreeFolderRow,
  type PathTreeRow,
  pathBasename,
} from "@/lib/path-tree";
import { cn } from "@/lib/utils";

export type PrTreeFile =
  | { path: string; additions: number; deletions: number; sourceOnly?: false }
  | { path: string; sourceOnly: true; undecodable?: boolean; entryId?: string };
type PrFile = PrTreeFile;
type FileTreeRow = PathTreeRow<PrFile>;
type FolderState = {
  allFiles: boolean;
  defaultCollapsed: boolean;
  expanded: ReadonlyMap<string, boolean>;
};

function folderExpanded(state: FolderState, path: string): boolean {
  return state.expanded.get(path) ?? !state.defaultCollapsed;
}

function visibleTreeRows(
  rows: FileTreeRow[],
  folders: FolderState,
): FileTreeRow[] {
  const visible: FileTreeRow[] = [];
  let closedDepth = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    if (row.depth > closedDepth) continue;
    closedDepth = Number.POSITIVE_INFINITY;
    visible.push(row);
    if (row.kind === "folder" && !folderExpanded(folders, row.path))
      closedDepth = row.depth;
  }
  return visible;
}

function rowKey(row: FileTreeRow): string {
  if (row.kind === "folder") return `folder:${row.path}`;
  return row.item.sourceOnly && row.item.undecodable
    ? `unreadable:${row.item.entryId ?? row.item.path}`
    : `file:${row.item.path}`;
}

/** The changed-file rail keeps directory state while its sidebar is collapsed. */
export function PrFilesTree({
  files,
  binaryPaths,
  effectivePath,
  onSelectPath,
  repoPath,
  blameRev,
  header,
  notice,
  allFiles = false,
  sourceLabel = "Unchanged",
  revealRequest,
}: {
  files: PrFile[];
  binaryPaths?: ReadonlySet<string>;
  effectivePath: string | null;
  onSelectPath: (path: string) => void;
  repoPath?: string;
  blameRev?: string;
  header?: ReactNode;
  notice?: ReactNode;
  allFiles?: boolean;
  sourceLabel?: string;
  revealRequest?: { path: string; id: number };
}) {
  const [folders, setFolders] = useState<FolderState>(() => ({
    allFiles,
    defaultCollapsed: allFiles,
    expanded: new Map(),
  }));
  const [cursor, setCursor] = useState<{
    selectedPath: string | null;
    key: string;
  } | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const lastRevealId = useRef<number | undefined>(undefined);
  const pendingReveal = useRef<{
    key: string;
    allFiles: boolean;
  } | null>(null);
  if (folders.allFiles !== allFiles) {
    setFolders({ allFiles, defaultCollapsed: true, expanded: new Map() });
    setCursor(null);
  }
  // Compaction stays independent of expansion so each child folder keeps its
  // own expansion choice when its parent opens.
  const allRows = useMemo(
    () => flattenPathTree(files, (file) => file.path, new Set<string>()),
    [files],
  );
  const rows = useMemo(
    () => visibleTreeRows(allRows, folders),
    [allRows, folders],
  );
  const changedFolders = useMemo(() => {
    const paths = new Set<string>();
    if (!allFiles) return paths;
    for (const file of files) {
      if (file.sourceOnly) continue;
      for (
        let separator = file.path.indexOf("/");
        separator !== -1;
        separator = file.path.indexOf("/", separator + 1)
      )
        paths.add(file.path.slice(0, separator));
    }
    return paths;
  }, [allFiles, files]);
  const activeKey =
    cursor?.selectedPath === effectivePath
      ? cursor.key
      : effectivePath !== null
        ? `file:${effectivePath}`
        : null;
  const activeIndex = rows.findIndex((row) => rowKey(row) === activeKey);
  const focusIndex = activeIndex === -1 ? 0 : activeIndex;
  const virtual = rows.length > 200;

  useLayoutEffect(() => {
    if (!revealRequest || Object.is(lastRevealId.current, revealRequest.id))
      return;
    lastRevealId.current = revealRequest.id;
    pendingReveal.current = null;
    pendingFocus.current = null;
    const target = allRows.find(
      (row) =>
        row.kind === "leaf" &&
        row.item.path === revealRequest.path &&
        !(row.item.sourceOnly && row.item.undecodable),
    );
    if (!target) return;
    setFolders((previous) => {
      const expanded = new Map(previous.expanded);
      for (
        let separator = revealRequest.path.indexOf("/");
        separator !== -1;
        separator = revealRequest.path.indexOf("/", separator + 1)
      )
        expanded.set(revealRequest.path.slice(0, separator), true);
      return { ...previous, expanded };
    });
    const key = rowKey(target);
    pendingReveal.current = { key, allFiles };
    setCursor({ selectedPath: effectivePath, key });
  }, [allFiles, allRows, effectivePath, revealRequest]);

  function rememberCursor(row: FileTreeRow) {
    setCursor({ selectedPath: effectivePath, key: rowKey(row) });
  }

  function activate(row: FileTreeRow) {
    pendingReveal.current = null;
    rememberCursor(row);
    if (row.kind === "leaf" && !(row.item.sourceOnly && row.item.undecodable))
      onSelectPath(row.item.path);
  }

  function focusRow(row: FileTreeRow) {
    activate(row);
    pendingFocus.current = rowKey(row);
  }

  function toggleFolder(row: PathTreeFolderRow) {
    pendingReveal.current = null;
    setFolders((previous) => {
      const expanded = new Map(previous.expanded);
      expanded.set(row.path, !folderExpanded(previous, row.path));
      return { ...previous, expanded };
    });
    // A click may leave focus on a hidden child, so every toggle lands focus on
    // its folder after the new visible rows commit.
    const key = rowKey(row);
    setCursor({ selectedPath: effectivePath, key });
    pendingFocus.current = key;
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: cursor commits mount a virtual row before pending focus lands.
  useLayoutEffect(() => {
    const key = pendingFocus.current;
    if (key === null) return;
    pendingFocus.current = null;
    if (!rows.some((row) => rowKey(row) === key)) return;
    const element = treeRef.current?.querySelector<HTMLElement>(
      `[data-file-tree-key="${CSS.escape(key)}"]`,
    );
    element?.focus({ preventScroll: true });
    element?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [rows, cursor]);

  const revealPending = useCallback(() => {
    const request = pendingReveal.current;
    if (request === null) return;
    if (request.allFiles !== allFiles) {
      pendingReveal.current = null;
      return;
    }
    if (
      cursor?.key !== request.key ||
      !rows.some((row) => rowKey(row) === request.key)
    )
      return;
    const element = treeRef.current?.querySelector<HTMLElement>(
      `[data-file-tree-key="${CSS.escape(request.key)}"]`,
    );
    if (!element) return;
    pendingReveal.current = null;
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
    element
      .querySelector<HTMLElement>("[data-file-tree-name]")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [allFiles, rows, cursor]);

  useLayoutEffect(() => {
    if (!virtual) revealPending();
  }, [virtual, revealPending]);

  const onListKeyDown = listKeyboardNav({
    items: rows,
    activeIndex,
    onActivate: focusRow,
    rowKey,
    rowAttr: "data-file-tree-key",
  });

  function onKeyDown(event: KeyboardEvent) {
    if (event.defaultPrevented) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (hasChordModifier(event)) return;
      const row = rows[focusIndex];
      if (!row) return;
      event.preventDefault();
      if (event.key === "ArrowRight") {
        if (row.kind !== "folder") return;
        if (!folderExpanded(folders, row.path)) toggleFolder(row);
        else {
          const child = rows[focusIndex + 1];
          if (child && child.depth > row.depth) focusRow(child);
        }
      } else if (row.kind === "folder" && folderExpanded(folders, row.path)) {
        toggleFolder(row);
      } else {
        for (let index = focusIndex - 1; index >= 0; index--) {
          if (rows[index].depth < row.depth) {
            focusRow(rows[index]);
            break;
          }
        }
      }
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      if (hasChordModifier(event)) return;
      const row = rows[event.key === "Home" ? 0 : rows.length - 1];
      if (row) {
        event.preventDefault();
        focusRow(row);
      }
      return;
    }
    onListKeyDown(event);
  }

  function renderRow(row: FileTreeRow, index: number, style?: CSSProperties) {
    const unreadable =
      row.kind === "leaf" && row.item.sourceOnly && row.item.undecodable;
    const selected =
      !unreadable && row.kind === "leaf" && row.item.path === effectivePath;
    const expanded = row.kind === "folder" && folderExpanded(folders, row.path);
    const containsChanges =
      row.kind === "folder" && changedFolders.has(row.path);
    const sourceOnly = row.kind === "leaf" && row.item.sourceOnly;
    return (
      <button
        key={rowKey(row)}
        type="button"
        role="treeitem"
        aria-level={row.depth + 1}
        aria-expanded={row.kind === "folder" ? expanded : undefined}
        aria-selected={selected}
        aria-current={selected || undefined}
        aria-disabled={unreadable || undefined}
        aria-label={row.kind === "folder" ? row.label : undefined}
        aria-description={containsChanges ? "Contains MR changes" : undefined}
        data-file-tree-key={rowKey(row)}
        data-path={
          row.kind === "leaf" && !unreadable ? row.item.path : undefined
        }
        tabIndex={index === focusIndex ? 0 : -1}
        className={cn(
          "flex w-full items-center gap-2 whitespace-nowrap py-1.5 pr-3 text-left text-xs outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          selected
            ? "bg-accent text-accent-foreground"
            : containsChanges
              ? "bg-primary/5 text-primary hover:bg-primary/10"
              : sourceOnly
                ? "text-muted-foreground hover:bg-muted/60"
                : "hover:bg-muted/60",
        )}
        style={{ paddingLeft: 12 + row.depth * 16, ...style }}
        onFocus={() => rememberCursor(row)}
        onClick={() =>
          row.kind === "folder" ? toggleFolder(row) : activate(row)
        }
      >
        {row.kind === "folder" ? (
          <>
            {expanded ? (
              <CaretDownIcon aria-hidden className="size-3 shrink-0" />
            ) : (
              <CaretRightIcon aria-hidden className="size-3 shrink-0" />
            )}
            {expanded ? (
              <FolderOpenIcon
                aria-hidden
                className={cn(
                  "size-3.5 shrink-0",
                  containsChanges ? "text-primary" : "text-muted-foreground",
                )}
              />
            ) : (
              <FolderIcon
                aria-hidden
                className={cn(
                  "size-3.5 shrink-0",
                  containsChanges ? "text-primary" : "text-muted-foreground",
                )}
              />
            )}
            <span className="shrink-0 font-mono">{row.label}</span>
            {containsChanges && (
              <span className="ml-auto shrink-0 border border-primary/25 bg-primary/10 px-1 text-[10px] font-medium text-primary">
                Changes
              </span>
            )}
          </>
        ) : (
          <>
            <span aria-hidden className="size-3 shrink-0" />
            {sourceOnly ? (
              <FileDashedIcon aria-hidden className="size-3.5 shrink-0" />
            ) : (
              <FileIcon
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground"
              />
            )}
            <span className="flex-1 whitespace-nowrap font-mono">
              <span className="sr-only">
                {row.item.path.slice(0, row.item.path.lastIndexOf("/") + 1)}
              </span>
              <span data-file-tree-name>{pathBasename(row.item.path)}</span>
            </span>
            <PrFileStatus
              file={row.item}
              isBinary={binaryPaths?.has(row.item.path) ?? false}
              sourceLabel={sourceLabel}
            />
          </>
        )}
      </button>
    );
  }

  const tree = virtual ? (
    <VirtualPrTreeRows
      rows={rows}
      focusIndex={focusIndex}
      treeRef={treeRef}
      onKeyDown={onKeyDown}
      renderRow={renderRow}
      sourceLabel={sourceLabel}
      onLayoutReady={revealPending}
    />
  ) : (
    <div ref={treeRef} className="w-max min-w-full py-1" onKeyDown={onKeyDown}>
      {rows.map((row, index) => renderRow(row, index))}
    </div>
  );
  const content =
    repoPath !== undefined ? (
      <FileRowActions
        repoPath={repoPath}
        blameRev={blameRev}
        className={virtual ? "flex min-h-0 flex-1 flex-col" : undefined}
      >
        {tree}
      </FileRowActions>
    ) : (
      tree
    );

  return (
    <DetailRail
      ariaLabel={allFiles ? "All files" : "Changed files"}
      role="tree"
      className="min-w-0"
      header={header}
      headerClassName="flex-1"
    >
      {notice}
      {virtual ? (
        content
      ) : (
        <ScrollArea className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {content}
        </ScrollArea>
      )}
    </DetailRail>
  );
}

function PrFileStatus({
  file,
  isBinary,
  sourceLabel,
}: {
  file: PrTreeFile;
  isBinary: boolean;
  sourceLabel: string;
}) {
  if (file.sourceOnly) {
    return (
      <span className="shrink-0 border border-dashed px-1 text-[10px] text-muted-foreground">
        {file.undecodable ? "Unreadable name" : sourceLabel}
      </span>
    );
  }
  return (
    <DiffStat
      added={file.additions}
      deleted={file.deletions}
      isBinary={isBinary}
    />
  );
}

/** Large repository trees keep only the viewport and roving tab stop mounted. */
function VirtualPrTreeRows({
  rows,
  focusIndex,
  treeRef,
  onKeyDown,
  renderRow,
  sourceLabel,
  onLayoutReady,
}: {
  rows: FileTreeRow[];
  focusIndex: number;
  treeRef: RefObject<HTMLDivElement | null>;
  onKeyDown: (event: KeyboardEvent) => void;
  renderRow: (
    row: FileTreeRow,
    index: number,
    style?: CSSProperties,
  ) => ReactNode;
  sourceLabel: string;
  onLayoutReady: () => void;
}) {
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const getItemKey = useCallback(
    (index: number) => rowKey(rows[index]),
    [rows],
  );
  const rangeExtractor = useCallback(
    (range: Parameters<typeof defaultRangeExtractor>[0]) =>
      [...new Set([...defaultRangeExtractor(range), focusIndex])].sort(
        (a, b) => a - b,
      ),
    [focusIndex],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    getItemKey,
    estimateSize: () => 28,
    rangeExtractor,
    overscan: 8,
  });
  // Attaching a virtualizer writes its initial scroll offset. Reveal only
  // after that write, retrying later commits if its pinned row is not mounted.
  useLayoutEffect(() => {
    if (scrollEl && virtualizer.scrollElement === scrollEl) onLayoutReady();
  });
  const width = useMemo(
    () =>
      rows.reduce((maximum, row) => {
        const label =
          row.kind === "folder" ? row.label : pathBasename(row.item.path);
        const characters = Array.from(label).reduce(
          (sum, char) => sum + (char.charCodeAt(0) > 255 ? 2 : 1),
          0,
        );
        const suffix =
          row.kind === "leaf" && row.item.sourceOnly
            ? sourceLabel.length * 7
            : 70;
        return Math.max(maximum, characters * 8 + row.depth * 16 + suffix + 88);
      }, 288),
    [rows, sourceLabel],
  );
  return (
    <div ref={setScrollEl} className="min-h-0 flex-1 overflow-auto">
      <div
        ref={treeRef}
        className="relative min-w-full"
        style={{ height: virtualizer.getTotalSize(), width }}
        onKeyDown={onKeyDown}
      >
        {virtualizer.getVirtualItems().map((item) =>
          renderRow(rows[item.index], item.index, {
            position: "absolute",
            top: 0,
            left: 0,
            height: 28,
            transform: `translateY(${item.start}px)`,
          }),
        )}
      </div>
    </div>
  );
}
