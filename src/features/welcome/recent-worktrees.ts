import { normPath } from "@/lib/git/path";
import { isSessionBranchName } from "@/lib/git/ref-name";
import type { UserWorktree } from "@/lib/git/worktree";
import type { RecentRepo } from "@/lib/settings/api";
import { validEpochMs } from "@/lib/time";

export interface RecentWorktree {
  key: string;
  repo: RecentRepo;
  worktree: UserWorktree;
  activityMs: number | null;
}

export function recentWorktrees(
  sources: readonly { repo: RecentRepo; worktrees: readonly UserWorktree[] }[],
): RecentWorktree[] {
  const ordered = sources.flatMap(({ repo, worktrees }) =>
    worktrees
      .filter(
        (worktree) => !worktree.isMain && !isSessionBranchName(worktree.branch),
      )
      .map((worktree) => ({
        key: normPath(worktree.path),
        repo,
        worktree,
        activityMs:
          typeof worktree.lastActivityMs === "number" &&
          validEpochMs(worktree.lastActivityMs)
            ? worktree.lastActivityMs
            : null,
      })),
  );
  ordered.sort((left, right) => {
    if (left.activityMs === null) return right.activityMs === null ? 0 : 1;
    if (right.activityMs === null) return -1;
    return right.activityMs - left.activityMs;
  });
  const seen = new Set<string>();
  return ordered
    .filter((entry) => {
      if (seen.has(entry.key)) return false;
      seen.add(entry.key);
      return true;
    })
    .slice(0, 20);
}
