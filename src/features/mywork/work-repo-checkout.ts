import { parentDir } from "@/features/welcome/clone-utils";
import { repoOriginPath, validateRepo } from "@/lib/git/api";
import type { MyWorkItem, RepoInfo, RepoOrigin } from "@/lib/git/types";
import type { RecentRepo } from "@/lib/settings/api";
import { repositoryDocumentId } from "@/lib/stores/work-documents";

export type WorkRepoIdentity = Pick<
  MyWorkItem,
  "host" | "repoFullName" | "provider" | "url"
>;

/** A stored row is a hint; every axis of its live origin must agree. */
export function workRepoOriginMatches(
  item: WorkRepoIdentity,
  origin: RepoOrigin,
): boolean {
  let authority: string;
  try {
    const url = new URL(item.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    authority = url.host.toLowerCase();
  } catch {
    return false;
  }
  return (
    origin.host !== "" &&
    origin.authority !== "" &&
    origin.path !== "" &&
    origin.provider !== "" &&
    origin.host.toLowerCase() === item.host.toLowerCase() &&
    origin.authority.toLowerCase() === authority &&
    origin.path.toLowerCase() === item.repoFullName.toLowerCase() &&
    origin.provider === item.provider
  );
}

/** The exact child folder a named clone would create, never a namespace traversal. */
export function workRepoClonePath(parent: string, name: string): string | null {
  if (!parent || !name || name === "." || name === ".." || /[/\\\0]/.test(name))
    return null;
  const separator =
    parent.lastIndexOf("\\") > parent.lastIndexOf("/") ? "\\" : "/";
  return `${parent.replace(/[/\\]+$/, "")}${separator}${name}`;
}

/** Finite hints from saved paths and their known parents; no directory scanning. */
export function workRepoCandidates(
  item: Pick<MyWorkItem, "repoName">,
  recents: readonly RecentRepo[],
  preferred: readonly RecentRepo[] = [],
): RecentRepo[] {
  const candidates: RecentRepo[] = [];
  const seen = new Set<string>();
  const add = (candidate: RecentRepo) => {
    const key = repositoryDocumentId({ repoPath: candidate.path });
    if (!candidate.path || seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };
  for (const candidate of preferred) add(candidate);
  // The first recent supplies CloneRepoDialog's default parent. Other known
  // parents cover checkouts opened from more than one workspace.
  for (const recent of recents) {
    const parent = parentDir(recent.path);
    const path = workRepoClonePath(parent, item.repoName);
    if (path) add({ path, name: item.repoName, lastOpenedAt: "" });
  }
  for (const recent of recents)
    if (recent.name === item.repoName || recent.repoName === item.repoName)
      add(recent);
  for (const recent of recents) add(recent);
  return candidates;
}

/** Read-only proof of a checkout root, with ownership re-checked between reads. */
export async function proveWorkRepoCheckout(
  item: WorkRepoIdentity,
  path: string,
  stillValid: () => boolean,
): Promise<RepoInfo | null> {
  if (!stillValid()) return null;
  try {
    const info = await validateRepo(path);
    if (
      !stillValid() ||
      repositoryDocumentId({ repoPath: info.root }) !==
        repositoryDocumentId({ repoPath: path })
    )
      return null;
    const origin = await repoOriginPath(info.root);
    return stillValid() && workRepoOriginMatches(item, origin) ? info : null;
  } catch {
    return null;
  }
}

export function workRepoRecent(
  item: Pick<MyWorkItem, "host" | "repoOwner" | "repoName" | "provider">,
  info: RepoInfo,
): RecentRepo {
  return {
    path: info.root,
    name: info.name,
    host: item.host,
    owner: item.repoOwner,
    repoName: item.repoName,
    provider: item.provider,
    lastOpenedAt: new Date().toISOString(),
  };
}
