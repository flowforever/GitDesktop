import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { type ReactNode, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitDiffView } from "@/features/diff/DiffSurface";
import { MrChatSelectionAction } from "@/features/pulls/mr-chat/MrChatSelectionAction";
import { PrFullFileDiff } from "@/features/pulls/PrFullFileDiff";
import { usePrDiffContext } from "@/features/pulls/usePrDiffContext";
import type { PrSnapshotComparison } from "@/lib/git/api/pr-snapshot";
import { prSnapshotComparisonOptions } from "@/lib/git/queries/pr-snapshot";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { stubCanvas } from "./canvas-stub";

const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);
const NEXT_HEAD = "c".repeat(40);
const PATH = "src/renamed.ts";
const OLD_PATH = "src/before.ts";
const REPO = "/project";

beforeEach(() => {
  stubCanvas();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 1000,
        bottom: 600,
        width: 1000,
        height: 600,
        toJSON: () => ({}),
      }) as DOMRect,
  );
});
afterEach(() => {
  document.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

const bytes = (text: string) => ({
  base64: btoa(text),
  mime: null,
  tooLarge: false,
  size: text.length,
});
const versions = {
  before: { path: OLD_PATH, revision: BASE },
  after: { path: PATH, revision: HEAD },
};

function fixture(
  oldPath: string | null = OLD_PATH,
  newPath: string | null = PATH,
): PrSnapshotComparison {
  return {
    baseSha: BASE,
    headSha: HEAD,
    oldPath,
    newPath,
    before: oldPath === null ? null : bytes("before()\n"),
    after: newPath === null ? null : bytes("after()\n"),
    patch: `diff --git a/${oldPath ?? newPath ?? PATH} b/${newPath ?? oldPath ?? PATH}\n--- ${oldPath === null ? "/dev/null" : `a/${oldPath}`}\n+++ ${newPath === null ? "/dev/null" : `b/${newPath}`}\n@@ -${oldPath === null ? "0,0" : "1"} +${newPath === null ? "0,0" : "1"} @@\n${oldPath === null ? "" : "-before()\n"}${newPath === null ? "" : "+after()\n"}`,
  };
}

function setup(pair = fixture()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
  const path = pair.newPath ?? pair.oldPath ?? PATH;
  client.setQueryData(
    prSnapshotComparisonOptions(REPO, 7, HEAD, path, "origin").queryKey,
    pair,
  );
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { wrapper, path, pair };
}

function NormalDiffSelection({
  pair,
  path,
  requested,
}: {
  pair: PrSnapshotComparison;
  path: string;
  requested: (
    request: import("@/features/pulls/mr-chat/context").MrChatSelectionRequest,
  ) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const context = usePrDiffContext({
    repoPath: REPO,
    number: 7,
    headSha: HEAD,
    lens: "origin",
    path,
    data: {
      filePath: path,
      text: pair.patch ?? "",
      isBinary: false,
      isTruncated: false,
    },
    enabled: true,
    composerOpen: false,
  });
  return (
    <div ref={hostRef} className="relative">
      <GitDiffView
        filePath={path}
        text={context.context?.patch ?? pair.patch ?? ""}
        anchorCommit={HEAD}
        fileContent={context.context?.content}
      />
      <MrChatSelectionAction
        hostRef={hostRef}
        context={{
          mr: {
            host: "git.example.com",
            repoFullName: "team/project",
            number: 7,
          },
          repoPath: REPO,
          headSha: HEAD,
        }}
        enabled
        onRequest={requested}
      />
    </div>
  );
}

describe("painted MR file versions", () => {
  it("preserves the exact before/after paths and commits in normal Diff context", () => {
    const view = setup();
    const hook = renderHook(
      () =>
        usePrDiffContext({
          repoPath: REPO,
          number: 7,
          headSha: HEAD,
          lens: "origin",
          path: view.path,
          data: {
            filePath: view.path,
            text: view.pair.patch ?? "",
            isBinary: false,
            isTruncated: false,
          },
          enabled: true,
          composerOpen: false,
        }),
      { wrapper: view.wrapper },
    );
    expect(hook.result.current.context?.content).toMatchObject({ versions });
  });

  it.each([
    { name: "added", oldPath: null, newPath: PATH },
    { name: "deleted", oldPath: OLD_PATH, newPath: null },
  ])(
    "verifies the null side and exact commits of a $name file in normal Diff",
    ({ oldPath, newPath }) => {
      const view = setup(fixture(oldPath, newPath));
      const hook = renderHook(
        () =>
          usePrDiffContext({
            repoPath: REPO,
            number: 7,
            headSha: HEAD,
            lens: "origin",
            path: view.path,
            data: {
              filePath: view.path,
              text: view.pair.patch ?? "",
              isBinary: false,
              isTruncated: false,
            },
            enabled: true,
            composerOpen: false,
          }),
        { wrapper: view.wrapper },
      );
      expect(hook.result.current.context?.content).toMatchObject({
        old: oldPath === null ? null : "before()\n",
        new: newPath === null ? null : "after()\n",
        versions: {
          before: { path: oldPath, revision: BASE },
          after: { path: newPath, revision: HEAD },
        },
      });
    },
  );

  it.each([
    {
      name: "added",
      oldPath: null,
      newPath: PATH,
      side: "new",
      text: "after()",
    },
    {
      name: "deleted",
      oldPath: OLD_PATH,
      newPath: null,
      side: "old",
      text: "before()",
    },
  ])(
    "offers Add to chat on the verified $name normal Diff code",
    async ({ oldPath, newPath, side, text }) => {
      const view = setup(fixture(oldPath, newPath));
      const requested = vi.fn();
      render(
        <NormalDiffSelection
          pair={view.pair}
          path={view.path}
          requested={requested}
        />,
        { wrapper: view.wrapper },
      );
      const painted = await screen.findByRole("group", {
        name: `Diff of ${view.path}`,
      });
      expect(painted).toHaveAttribute("data-diff-head-sha", HEAD);
      const code = painted.querySelector<HTMLElement>(
        ".diff-line-content-raw [data-template], .diff-line-syntax-raw [data-template]",
      );
      if (!code) throw new Error("Expected the painted normal Diff code");
      const range = document.createRange();
      range.selectNodeContents(code);
      range.getBoundingClientRect = () =>
        ({
          x: 200,
          y: 180,
          top: 180,
          left: 200,
          right: 400,
          bottom: 200,
          width: 200,
          height: 20,
          toJSON: () => ({}),
        }) as DOMRect;
      act(() => {
        document.getSelection()?.removeAllRanges();
        document.getSelection()?.addRange(range);
        fireEvent.mouseUp(code);
      });
      fireEvent.click(
        await screen.findByRole("button", { name: "Add to chat" }),
      );
      expect(requested).toHaveBeenCalledWith(
        expect.objectContaining({
          headSha: HEAD,
          selection: expect.objectContaining({
            path: view.path,
            side,
            text,
            startLine: 1,
            endLine: 1,
          }),
        }),
      );
    },
  );

  it.each([
    { name: "renamed", oldPath: OLD_PATH, newPath: PATH },
    { name: "added", oldPath: null, newPath: PATH },
    { name: "deleted", oldPath: OLD_PATH, newPath: null },
  ])(
    "marks both authoritative revisions for a $name full comparison",
    async ({ oldPath, newPath }) => {
      const view = setup(fixture(oldPath, newPath));
      render(
        <PrFullFileDiff
          repoPath={REPO}
          number={7}
          headSha={HEAD}
          path={view.path}
          lens="origin"
          reportRead={() => undefined}
        />,
        { wrapper: view.wrapper },
      );
      const painted = await screen.findByRole("group", {
        name: `Diff of ${view.path}`,
      });
      expect(painted).toHaveAttribute("data-diff-before-path", oldPath ?? "");
      expect(painted).toHaveAttribute("data-diff-before-revision", BASE);
      expect(painted).toHaveAttribute("data-diff-after-path", newPath ?? "");
      expect(painted).toHaveAttribute("data-diff-after-revision", HEAD);
    },
  );

  it("retains version metadata with the verified model while a line composer is open", async () => {
    const view = setup();
    const content = { old: "before()\n", new: "after()\n", versions };
    const tree = (head = HEAD) => (
      <GitDiffView
        filePath={PATH}
        text={view.pair.patch ?? ""}
        anchorCommit={head}
        fileContent={{
          ...content,
          versions: { ...versions, after: { path: PATH, revision: head } },
        }}
      />
    );
    const mounted = render(tree(), { wrapper: view.wrapper });
    expect(
      await screen.findByRole("group", { name: `Diff of ${PATH}` }),
    ).toHaveAttribute("data-diff-after-revision", HEAD);
    const composer = document.createElement("div");
    composer.setAttribute("data-diff-line-widget", "layout");
    document.body.append(composer);
    try {
      mounted.rerender(tree(NEXT_HEAD));
      expect(
        screen.getByRole("group", { name: `Diff of ${PATH}` }),
      ).toHaveAttribute("data-diff-after-revision", HEAD);
      composer.remove();
      mounted.rerender(tree(NEXT_HEAD));
      expect(
        screen.getByRole("group", { name: `Diff of ${PATH}` }),
      ).toHaveAttribute("data-diff-after-revision", NEXT_HEAD);
    } finally {
      composer.remove();
    }
  });
});
