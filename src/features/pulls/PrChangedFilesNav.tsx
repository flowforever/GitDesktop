import { ArrowDownIcon, ArrowUpIcon } from "@phosphor-icons/react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { flattenPathTree } from "@/lib/path-tree";

type FilePath = { path: string };

/** Changed leaves keep the tree's order, including when its folders are closed. */
export function PrChangedFilesNav({
  files,
  treeFiles,
  currentPath,
  onSelectPath,
  disabled = false,
}: {
  files: readonly FilePath[];
  treeFiles?: readonly FilePath[];
  currentPath: string | null;
  onSelectPath: (path: string) => void;
  disabled?: boolean;
}) {
  const paths = useMemo(
    () =>
      flattenPathTree(
        [...(treeFiles ?? files)],
        (file) => file.path,
        new Set<string>(),
      ).flatMap((row) => (row.kind === "leaf" ? [row.item.path] : [])),
    [files, treeFiles],
  );
  const changedPaths = useMemo(
    () => new Set(files.map((file) => file.path)),
    [files],
  );
  const currentIndex = currentPath === null ? -1 : paths.indexOf(currentPath);
  let previousPath: string | null = null;
  let nextPath: string | null = null;
  for (const [index, path] of paths.entries()) {
    if (!changedPaths.has(path)) continue;
    if (currentIndex < 0) {
      previousPath = path;
      nextPath ??= path;
    } else if (index < currentIndex) previousPath = path;
    else if (index > currentIndex) nextPath ??= path;
  }

  function selectPrevious() {
    if (disabled || previousPath === null) return;
    onSelectPath(previousPath);
  }
  function selectNext() {
    if (disabled || nextPath === null) return;
    onSelectPath(nextPath);
  }

  useHotkeyAction(
    "pr-previous-changed-file",
    selectPrevious,
    !disabled && previousPath !== null,
  );
  useHotkeyAction(
    "pr-next-changed-file",
    selectNext,
    !disabled && nextPath !== null,
  );

  return (
    <span
      role="group"
      aria-label="Changed file navigation"
      className="inline-flex shrink-0 items-center gap-1"
    >
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Previous changed file"
        title="Previous changed file"
        disabled={disabled || previousPath === null}
        onClick={selectPrevious}
      >
        <ArrowUpIcon aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Next changed file"
        title="Next changed file"
        disabled={disabled || nextPath === null}
        onClick={selectNext}
      >
        <ArrowDownIcon aria-hidden />
      </Button>
    </span>
  );
}
