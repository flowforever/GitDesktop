import { invoke } from "@/lib/tauri/invoke";
import type { PathListingEntry, RemoteLens } from "../types";
import type { FileBytes } from "./workingtree";

export interface PrSnapshotComparison {
  baseSha: string;
  headSha: string;
  oldPath: string | null;
  newPath: string | null;
  before: FileBytes | null;
  after: FileBytes | null;
  patch: string | null;
}

/** Both authoritative MR versions, with a native blob diff for alignment. */
export const gitPrSnapshotComparison = (
  repoPath: string,
  number: number,
  headSha: string,
  filePath: string,
  lens: RemoteLens = "origin",
) =>
  invoke<PrSnapshotComparison>("git_pr_snapshot_comparison", {
    repoPath,
    number,
    headSha,
    filePath,
    lens,
  });

/** All paths in the exact MR head commit, fetching missing objects without
 *  changing the checkout or refs. The supplied SHA remains authoritative. */
export const gitPrSnapshotFiles = (
  repoPath: string,
  number: number,
  headSha: string,
  lens: RemoteLens,
) =>
  invoke<PathListingEntry[]>("git_pr_snapshot_files", {
    repoPath,
    number,
    headSha,
    lens,
  });

/** Exact snapshot bytes, hydrating missing objects without checkout or ref writes. */
export const gitPrSnapshotFile = (
  repoPath: string,
  headSha: string,
  path: string,
  lens: RemoteLens = "origin",
) =>
  invoke<FileBytes | null>("git_pr_snapshot_file", {
    repoPath,
    headSha,
    filePath: path,
    lens,
  });
