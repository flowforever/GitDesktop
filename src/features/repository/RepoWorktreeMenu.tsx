import {
  CaretDownIcon,
  FolderIcon,
  TreeStructureIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { PathText } from "@/components/path-text";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUserWorktreesPeek } from "@/lib/git/queries/worktrees";
import { isSessionBranchName } from "@/lib/git/ref-name";
import type { UserWorktree } from "@/lib/git/worktree";
import { isBareMainRow } from "@/lib/git/worktree-default-path";

export function RepoWorktreeMenu({
  repoPath,
  repoName,
  onSelectPath,
  onShownChange,
  disabled = false,
}: {
  repoPath: string;
  repoName: string;
  onSelectPath: (path: string) => void;
  onShownChange: (shown: boolean) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<UserWorktree[] | null>(null);
  const worktrees = useUserWorktreesPeek(repoPath, open && !disabled);
  // The first answer may arrive after opening; later answers wait until the
  // next opening so a refetch cannot replace the item under the pointer.
  if (open && snapshot === null && worktrees.data !== undefined)
    setSnapshot(
      worktrees.data.filter((tree) => !isSessionBranchName(tree.branch)),
    );

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (next && disabled) return;
        setOpen(next);
        if (next) {
          setSnapshot(
            worktrees.data?.filter(
              (tree) => !isSessionBranchName(tree.branch),
            ) ?? null,
          );
          onShownChange(true);
        }
      }}
      onOpenChangeComplete={(shown) => {
        if (!shown) {
          setSnapshot(null);
          onShownChange(false);
        }
      }}
    >
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="mr-1 h-7 gap-1 px-1.5"
            aria-label={`Worktrees for ${repoName}`}
            title={`Worktrees for ${repoName}`}
            disabled={disabled}
          />
        }
      >
        <TreeStructureIcon aria-hidden className="size-3.5" />
        <CaretDownIcon aria-hidden className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        aria-label={`Worktrees for ${repoName}`}
        className="w-80 max-w-[calc(100vw-2rem)]"
      >
        {snapshot === null ? (
          worktrees.isError ? (
            <>
              <p className="px-2 py-2 text-xs text-muted-foreground">
                Couldn't load worktrees.
              </p>
              <DropdownMenuItem
                closeOnClick={false}
                onClick={() => void worktrees.refetch()}
              >
                Retry
              </DropdownMenuItem>
            </>
          ) : (
            <p
              role="status"
              className="px-2 py-2 text-xs text-muted-foreground"
            >
              Loading worktrees…
            </p>
          )
        ) : snapshot.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            No worktrees found.
          </p>
        ) : (
          snapshot.map((tree) => {
            const bare = isBareMainRow(tree);
            const label = bare
              ? "Bare repository"
              : tree.isMain
                ? "Main workspace"
                : tree.isDetached
                  ? "Detached HEAD"
                  : tree.branch || "Worktree";
            return (
              <DropdownMenuItem
                key={tree.path}
                disabled={disabled || bare}
                title={
                  bare
                    ? "A bare repository has no workspace to open"
                    : tree.path
                }
                onClick={() => {
                  if (!disabled && !bare) onSelectPath(tree.path);
                }}
              >
                {tree.isMain ? (
                  <FolderIcon aria-hidden className="size-3.5 shrink-0" />
                ) : (
                  <TreeStructureIcon
                    aria-hidden
                    className="size-3.5 shrink-0"
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs">
                    {label}
                    {tree.isMain && tree.branch && (
                      <span className="text-muted-foreground">
                        {" "}
                        · {tree.branch}
                      </span>
                    )}
                  </span>
                  <PathText
                    path={tree.path}
                    className="text-[11px] text-muted-foreground"
                  />
                </span>
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
