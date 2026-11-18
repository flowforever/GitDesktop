import type { ReactNode } from "react";
import type { DiffFileVersions } from "@/features/diff/file-versions";
import type { PrSnapshotComparison } from "@/lib/git/api/pr-snapshot";
import { FULL_OID_RE } from "@/lib/git/oid";

/** Metadata remains useful when bytes are binary, empty or too large to paint. */
export function prComparisonVersions(
  comparison: PrSnapshotComparison | undefined,
  path: string,
  headSha: string,
): DiffFileVersions | undefined {
  if (
    !comparison ||
    !FULL_OID_RE.test(comparison.baseSha) ||
    !FULL_OID_RE.test(comparison.headSha) ||
    comparison.headSha.toLowerCase() !== headSha.toLowerCase() ||
    (comparison.oldPath !== null &&
      (typeof comparison.oldPath !== "string" || !comparison.oldPath)) ||
    (comparison.newPath !== null &&
      (typeof comparison.newPath !== "string" || !comparison.newPath)) ||
    (comparison.newPath ?? comparison.oldPath) !== path
  )
    return undefined;
  return {
    before: { path: comparison.oldPath, revision: comparison.baseSha },
    after: { path: comparison.newPath, revision: comparison.headSha },
  };
}

/** A non-code arm belongs to its captured file slot, just like code rows do.
 * Pending markers retain that identity while refusing any source provenance. */
export function PrFileContextMarker({
  path,
  headSha,
  oldPath,
  source = false,
  pending = false,
  versions,
  className,
  children,
}: {
  path: string;
  headSha: string | null | undefined;
  oldPath?: string;
  source?: boolean;
  pending?: boolean;
  versions?: DiffFileVersions;
  className?: string;
  children: ReactNode;
}) {
  const ready = !pending && !!headSha && FULL_OID_RE.test(headSha);
  return (
    <div
      className={className}
      data-diff-file-path={path}
      data-diff-old-file-path={oldPath}
      data-diff-content-side={source ? "new" : undefined}
      data-diff-context-pending={ready ? undefined : "true"}
      data-diff-head-sha={ready ? headSha : undefined}
      data-diff-before-path={
        ready && versions?.before ? (versions.before.path ?? "") : undefined
      }
      data-diff-before-revision={ready ? versions?.before?.revision : undefined}
      data-diff-after-path={
        ready && versions?.after ? (versions.after.path ?? "") : undefined
      }
      data-diff-after-revision={ready ? versions?.after?.revision : undefined}
    >
      {children}
    </div>
  );
}
