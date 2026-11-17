import { queryOptions, useQuery } from "@tanstack/react-query";
import {
  gitPrSnapshotComparison,
  gitPrSnapshotFile,
  gitPrSnapshotFiles,
} from "../api/pr-snapshot";
import type { RemoteLens } from "../types";

export function prSnapshotComparisonOptions(
  repoPath: string,
  number: number,
  headSha: string,
  path: string,
  lens: RemoteLens = "origin",
) {
  return queryOptions({
    queryKey: [
      "repo",
      repoPath,
      "pr",
      lens,
      number,
      "snapshot-comparison",
      headSha,
      path,
    ] as const,
    queryFn: () =>
      gitPrSnapshotComparison(repoPath, number, headSha, path, lens),
    networkMode: "online",
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    placeholderData: () => undefined,
    retry: false,
  });
}

export function prSnapshotFilesOptions(
  repoPath: string,
  number: number,
  headSha: string | null | undefined,
  lens: RemoteLens,
) {
  return queryOptions({
    queryKey: [
      "repo",
      repoPath,
      "pr-snapshot-files",
      lens,
      number,
      headSha ?? null,
    ] as const,
    queryFn: () => gitPrSnapshotFiles(repoPath, number, headSha ?? "", lens),
    // A missing local head needs a network fetch; already-cached snapshots
    // remain available offline and never go stale at the same immutable SHA.
    networkMode: "online",
    staleTime: Infinity,
    retry: false,
  });
}

export function usePrSnapshotFiles(
  repoPath: string,
  number: number,
  headSha: string | null | undefined,
  lens: RemoteLens,
  enabled: boolean,
) {
  return useQuery({
    ...prSnapshotFilesOptions(repoPath, number, headSha, lens),
    enabled: enabled && repoPath !== "" && number > 0 && !!headSha,
  });
}

export function prSnapshotFileOptions(
  repoPath: string,
  headSha: string,
  path: string,
  lens: RemoteLens = "origin",
) {
  return queryOptions({
    queryKey: [
      "repo",
      repoPath,
      "pr-snapshot-file",
      lens,
      headSha,
      path,
    ] as const,
    queryFn: () => gitPrSnapshotFile(repoPath, headSha, path, lens),
    networkMode: "online",
    staleTime: Infinity,
    retry: false,
  });
}
