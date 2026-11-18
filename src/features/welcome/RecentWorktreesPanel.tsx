import { TreeStructureIcon } from "@phosphor-icons/react";
import { useQueries } from "@tanstack/react-query";
import { useId } from "react";
import { ListRowSkeletons } from "@/components/list-row-skeleton";
import { PathText } from "@/components/path-text";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useOpenWorktree } from "@/features/repository/useOpenRepoByPath";
import { clipTitleFromText } from "@/lib/clip-title";
import { normPath } from "@/lib/git/path";
import {
  USER_WORKTREES_STALE_TIME,
  userWorktreesPeekOptions,
} from "@/lib/git/queries";
import { useRovingRows } from "@/lib/list-keyboard-nav";
import { repoDisplayName } from "@/lib/settings/api";
import { useSettings } from "@/lib/settings/queries";
import { recentWorktrees } from "./recent-worktrees";

export function RecentWorktreesPanel() {
  const settings = useSettings();
  const openWorktree = useOpenWorktree();
  const headingId = useId();
  const seenRepos = new Set<string>();
  const repos = (settings.data?.recentRepos ?? []).filter((repo) => {
    const key = normPath(repo.path);
    if (seenRepos.has(key)) return false;
    seenRepos.add(key);
    return true;
  });
  const reads = useQueries({
    queries: repos.map((repo) => ({
      ...userWorktreesPeekOptions(repo.path),
      staleTime: USER_WORKTREES_STALE_TIME,
    })),
  });
  const entries = recentWorktrees(
    repos.map((repo, index) => ({ repo, worktrees: reads[index].data ?? [] })),
  );
  const navigation = useRovingRows({
    items: entries,
    rowKey: (entry) => entry.key,
  });
  const loading = settings.isPending || reads.some((read) => read.isPending);
  const failed = settings.isError || reads.some((read) => read.isError);

  function retry() {
    if (settings.isError) void settings.refetch();
    for (const read of reads) {
      if (read.isError) void read.refetch();
    }
  }

  return (
    <section
      aria-labelledby={headingId}
      className="mt-2 flex min-h-0 flex-1 flex-col gap-2"
    >
      <div className="shrink-0 px-1">
        <div className="flex items-center justify-between gap-2">
          <h2 id={headingId} className="font-heading text-sm font-medium">
            Recent worktrees
          </h2>
          {entries.length > 0 && (
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {entries.length}
            </span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Latest 20 by Git activity
        </p>
      </div>
      {failed && (
        <div className="flex shrink-0 items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
          <p>Couldn't load some worktrees. Showing available worktrees.</p>
          <Button size="xs" variant="ghost" onClick={retry}>
            Retry
          </Button>
        </div>
      )}
      {loading && entries.length > 0 && (
        <p role="status" className="px-1 text-[11px] text-muted-foreground">
          Loading more worktrees…
        </p>
      )}
      <ScrollArea className="h-72 min-h-0 overflow-hidden border bg-background md:h-auto md:flex-1">
        {entries.length > 0 ? (
          <ul
            role="listbox"
            aria-label="Recent worktrees"
            onKeyDown={navigation.onRowKeyDown}
          >
            {entries.map((entry) => {
              const { repo, worktree, activityMs } = entry;
              const name =
                worktree.branch ||
                worktree.path.split(/[\\/]/).filter(Boolean).at(-1) ||
                "Detached worktree";
              return (
                <li key={entry.key} role="presentation">
                  <button
                    {...navigation.rowProps(entry)}
                    type="button"
                    role="option"
                    aria-selected={navigation.isActive(entry)}
                    className="flex w-full min-w-0 items-start gap-2 border-b px-3 py-2 text-left outline-none hover:bg-muted/50 focus-visible:bg-accent focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                    onClick={() => void openWorktree(worktree.path)}
                  >
                    <TreeStructureIcon
                      aria-hidden
                      className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center justify-between gap-2">
                        <span
                          className="truncate text-xs font-medium"
                          onMouseEnter={clipTitleFromText}
                        >
                          {repoDisplayName(repo)}
                        </span>
                        {activityMs !== null && (
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            <RelativeTime
                              date={new Date(activityMs).toISOString()}
                            />
                          </span>
                        )}
                      </span>
                      <span
                        className="block truncate font-mono text-[11px]"
                        onMouseEnter={clipTitleFromText}
                      >
                        {name}
                      </span>
                      <PathText
                        path={worktree.path}
                        className="text-[11px] text-muted-foreground"
                      />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : loading ? (
          <ListRowSkeletons rows={3} lines={3} name="recent worktrees" />
        ) : !failed ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            No linked worktrees yet.
          </div>
        ) : null}
      </ScrollArea>
    </section>
  );
}
