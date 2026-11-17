import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useRef } from "react";
import { toast } from "sonner";
import { lineComposerOpen } from "@/features/diff/whitespace-mode";
import { FULL_OID_RE } from "@/lib/git/oid";
import {
  prSnapshotComparisonOptions,
  prSnapshotFileOptions,
  prSnapshotFilesOptions,
} from "@/lib/git/queries/pr-snapshot";
import type { RemoteLens } from "@/lib/git/types";
import { useUiStore } from "@/lib/stores/ui";
import { toastErrorWithNote } from "@/lib/toast";
import { PR_CODE_IMPORT_MAX_CHARS } from "./pr-code-imports";
import { decodePrFullFile } from "./pr-full-context";
import { resolvePrImport } from "./pr-import-resolution";

type Navigation = {
  repoPath: string;
  number: number;
  lens: RemoteLens;
  headSha: string;
  path: string | null;
  enabled: boolean;
  comparisonSupported: boolean;
  onNavigate: (path: string) => void;
};

function identity(value: Navigation) {
  return JSON.stringify([
    value.repoPath,
    value.lens,
    value.number,
    value.headSha,
    value.path,
  ]);
}

function textOf(data: Parameters<typeof decodePrFullFile>[0]): string | null {
  const result = decodePrFullFile(data);
  return result.kind === "text" &&
    result.text !== null &&
    result.text.length <= PR_CODE_IMPORT_MAX_CHARS
    ? result.text
    : null;
}

/** Snapshot reads may outlive the file, request or navigation that started them. */
export function usePrImportNavigation(value: Navigation) {
  const queryClient = useQueryClient();
  const live = useRef<Navigation | null>(null);
  const generation = useRef(0);
  const activation = useRef(0);
  useLayoutEffect(() => {
    if (
      live.current === null ||
      identity(live.current) !== identity(value) ||
      (live.current.enabled && !value.enabled)
    )
      generation.current++;
    live.current = value;
  });
  useLayoutEffect(
    () => () => {
      live.current = null;
      generation.current++;
    },
    [],
  );

  const onOpen = useCallback(
    async (specifier: string, sourcePath: string) => {
      const start = live.current;
      if (!start?.enabled || lineComposerOpen()) return;
      useUiStore.getState().noteUserInteraction();
      const epoch = useUiStore.getState().interactionEpoch;
      const request = ++activation.current;
      const version = generation.current;
      const current = () =>
        live.current !== null &&
        live.current.enabled &&
        generation.current === version &&
        activation.current === request &&
        useUiStore.getState().interactionEpoch === epoch &&
        !lineComposerOpen();
      try {
        const files = await queryClient.fetchQuery(
          prSnapshotFilesOptions(
            start.repoPath,
            start.number,
            start.headSha,
            start.lens,
          ),
        );
        if (!current()) return;
        const paths = new Set(
          files.filter((file) => !file.undecodable).map((file) => file.path),
        );
        const target = await resolvePrImport({
          sourcePath,
          specifier,
          paths,
          readText: async (path) => {
            if (!current() || !paths.has(path)) return null;
            const data = await queryClient.fetchQuery(
              prSnapshotFileOptions(
                start.repoPath,
                start.headSha,
                path,
                start.lens,
              ),
            );
            return current() ? textOf(data) : null;
          },
        });
        if (!current()) return;
        if (target === null) {
          toast.info(`Could not find ${specifier} in this request's files.`);
          return;
        }
        live.current?.onNavigate(target);
      } catch (error) {
        if (current())
          toastErrorWithNote(error, "The current file is still open.");
      }
    },
    [queryClient],
  );

  const getSource = useCallback(
    async (side: "old" | "new") => {
      const start = live.current;
      if (!start?.enabled || start.path === null) return null;
      const version = generation.current;
      const current = () =>
        live.current?.enabled && generation.current === version;
      try {
        if (side === "new") {
          const files = await queryClient.fetchQuery(
            prSnapshotFilesOptions(
              start.repoPath,
              start.number,
              start.headSha,
              start.lens,
            ),
          );
          if (
            !current() ||
            !files.some((file) => !file.undecodable && file.path === start.path)
          )
            return null;
          const data = await queryClient.fetchQuery(
            prSnapshotFileOptions(
              start.repoPath,
              start.headSha,
              start.path,
              start.lens,
            ),
          );
          const text = textOf(data);
          return current() && text !== null ? { path: start.path, text } : null;
        }
        if (!start.comparisonSupported) return null;
        const pair = await queryClient.fetchQuery(
          prSnapshotComparisonOptions(
            start.repoPath,
            start.number,
            start.headSha,
            start.path,
            start.lens,
          ),
        );
        if (
          !current() ||
          pair.headSha.toLowerCase() !== start.headSha.toLowerCase() ||
          !FULL_OID_RE.test(pair.baseSha) ||
          typeof pair.oldPath !== "string" ||
          (pair.newPath ?? pair.oldPath) !== start.path
        )
          return null;
        const text = textOf(pair.before);
        return text === null ? null : { path: pair.oldPath, text };
      } catch {
        return null;
      }
    },
    [queryClient],
  );

  return { onOpen, getSource };
}
