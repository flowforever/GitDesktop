import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
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
import { resolveCodeImportCandidates } from "./code-import-resolution";
import { PR_CODE_IMPORT_MAX_CHARS } from "./pr-code-imports";
import { decodePrFullFile } from "./pr-full-context";

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
type ImportChoices = {
  specifier: string;
  paths: string[];
  identity: string;
  epoch: number;
  generation: number;
  request: number;
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
  const epochNow = useUiStore((state) => state.interactionEpoch);
  const [pendingChoices, setPendingChoices] = useState<ImportChoices | null>(
    null,
  );
  useLayoutEffect(() => {
    if (
      live.current === null ||
      identity(live.current) !== identity(value) ||
      (live.current.enabled && !value.enabled)
    )
      generation.current++;
    live.current = value;
    if (
      pendingChoices &&
      (!value.enabled ||
        pendingChoices.identity !== identity(value) ||
        pendingChoices.epoch !== epochNow)
    )
      setPendingChoices(null);
  });
  useLayoutEffect(
    () => () => {
      live.current = null;
      generation.current++;
    },
    [],
  );

  const onOpen = useCallback(
    async (specifier: string, sourcePath: string, kind?: string) => {
      const start = live.current;
      if (!start?.enabled || lineComposerOpen()) return;
      useUiStore.getState().noteUserInteraction();
      const epoch = useUiStore.getState().interactionEpoch;
      const request = ++activation.current;
      setPendingChoices(null);
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
        const candidates = await resolveCodeImportCandidates({
          sourcePath,
          specifier,
          kind,
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
        const targets = [...new Set(candidates)]
          .filter((path) => paths.has(path))
          .slice(0, 64);
        if (targets.length === 0) {
          toast.info(`Could not find ${specifier} in this request's files.`);
          return;
        }
        if (targets.length === 1) live.current?.onNavigate(targets[0]);
        else
          setPendingChoices({
            specifier,
            paths: targets,
            identity: identity(start),
            epoch,
            generation: version,
            request,
          });
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

  const choices =
    pendingChoices &&
    value.enabled &&
    pendingChoices.identity === identity(value) &&
    pendingChoices.epoch === epochNow
      ? pendingChoices
      : null;
  const chooseTarget = (path: string) => {
    if (
      !choices ||
      !live.current?.enabled ||
      choices.generation !== generation.current ||
      choices.request !== activation.current ||
      choices.epoch !== useUiStore.getState().interactionEpoch ||
      lineComposerOpen() ||
      !choices.paths.includes(path)
    )
      return;
    setPendingChoices(null);
    live.current.onNavigate(path);
  };
  const dismissChoices = () => {
    activation.current++;
    setPendingChoices(null);
  };
  return { onOpen, getSource, choices, chooseTarget, dismissChoices };
}
