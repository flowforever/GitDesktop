import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseMrChatFileReference,
  useMrChatFileNavigation,
} from "@/features/pulls/mr-chat/useMrChatFileNavigation";
import { PrDiffSearch } from "@/features/pulls/PrDiffSearch";
import { PrFilesPane } from "@/features/pulls/RemotePrViewParts";
import { gitObjectsPresent } from "@/lib/git/api";
import {
  gitPrSnapshotComparison,
  gitPrSnapshotFile,
  gitPrSnapshotFiles,
} from "@/lib/git/api/pr-snapshot";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { stubCanvas } from "./canvas-stub";

vi.mock("@/lib/git/api", async (original) => ({
  ...(await original<typeof import("@/lib/git/api")>()),
  gitObjectsPresent: vi.fn(),
}));
vi.mock("@/lib/git/api/pr-snapshot", async (original) => ({
  ...(await original<typeof import("@/lib/git/api/pr-snapshot")>()),
  gitPrSnapshotFiles: vi.fn(),
  gitPrSnapshotFile: vi.fn(),
  gitPrSnapshotComparison: vi.fn(),
}));

Element.prototype.scrollIntoView ??= () => undefined;

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const SCOPE = {
  mr: { host: "git.example.com", repoFullName: "team/project", number: 7 },
  repoPath: "/repos/project",
  number: 7,
  lens: "origin" as const,
  headSha: HEAD,
  enabled: true,
  changedFiles: [
    { path: "src/entry.ts" },
    { path: "src/renamed.ts", oldPath: "legacy/before.ts" },
    { path: "src/deleted.ts", deleted: true },
  ],
};
const listing = [
  "src/entry.ts",
  "src/renamed.ts",
  "src/context.ts",
  "src/duplicate.ts",
  "test/duplicate.ts",
].map((path) => ({ path, undecodable: false }));
const snapshot = vi.mocked(gitPrSnapshotFiles);
const bytes = (text: string) => ({
  base64: btoa(text),
  mime: null,
  size: text.length,
  tooLarge: false,
});
const oldLines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
const newLines = oldLines.map((line, index) =>
  index === 9 ? "changed 10" : line,
);
const patch = (path: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -10 +10 @@\n-line 10\n+changed 10\n`;
const clients: QueryClient[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  stubCanvas();
  snapshot.mockResolvedValue(listing);
  vi.mocked(gitObjectsPresent).mockResolvedValue(false);
  vi.mocked(gitPrSnapshotFile).mockResolvedValue(bytes("unchanged source\n"));
  vi.mocked(gitPrSnapshotComparison).mockImplementation(
    async (_repo, _number, head, path) => ({
      baseSha: BASE,
      headSha: head,
      oldPath: path,
      newPath: path,
      before: bytes(`${oldLines.join("\n")}\n`),
      after: bytes(`${newLines.join("\n")}\n`),
      patch: patch(path),
    }),
  );
  vi.spyOn(toast, "info").mockReturnValue(0);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1200,
    bottom: 800,
    width: 1200,
    height: 800,
    toJSON: () => ({}),
  });
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  client.setQueryData(settingsKeys.settings, {
    ...DEFAULT_SETTINGS,
    diffViewMode: "unified",
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("MR chat file references", () => {
  it("preserves positive line locators on relative and current-checkout absolute paths", () => {
    expect(
      parseMrChatFileReference("./src/entry.ts:10:3", SCOPE.repoPath),
    ).toEqual({
      path: "src/entry.ts",
      line: 10,
      column: 3,
    });
    expect(
      parseMrChatFileReference(
        "/repos/project/src/entry.ts#L10-L14",
        SCOPE.repoPath,
      ),
    ).toEqual({ path: "src/entry.ts", line: 10 });
    expect(
      parseMrChatFileReference(
        "C:/repos/project/src/entry.ts:9",
        "C:/repos/project",
      ),
    ).toEqual({ path: "src/entry.ts", line: 9 });
  });

  it.each([
    "https://example.com/src/entry.ts#L10",
    "file:///repos/project/src/entry.ts",
    "/repos/project-other/src/entry.ts",
    "../outside.ts",
    "%2e%2e/outside.ts",
    "src/entry.ts:0",
  ])("rejects an out-of-scope or invalid reference: %s", (reference) => {
    expect(parseMrChatFileReference(reference, SCOPE.repoPath)).toBeNull();
  });

  it("opens exact changed, renamed old-side and deleted references without loading all snapshot files", async () => {
    const onNavigate = vi.fn();
    const view = renderHook(
      () => useMrChatFileNavigation({ ...SCOPE, onNavigate }),
      { wrapper: wrapper() },
    );
    expect(snapshot).not.toHaveBeenCalled();
    await act(() => view.result.current.onOpenFile("src/entry.ts#L10"));
    expect(view.result.current.request).toMatchObject({
      path: "src/entry.ts",
      kind: "change",
      side: "new",
      line: 10,
      headSha: HEAD,
    });
    await act(() => view.result.current.onOpenFile("legacy/before.ts:12"));
    expect(view.result.current.request).toMatchObject({
      path: "src/renamed.ts",
      kind: "change",
      side: "old",
      line: 12,
    });
    await act(() => view.result.current.onOpenFile("src/deleted.ts:5"));
    expect(view.result.current.request).toMatchObject({
      path: "src/deleted.ts",
      kind: "change",
      side: "old",
      line: 5,
    });
    expect(snapshot).not.toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledTimes(3);
  });

  it("loads unchanged snapshot paths only on intent and refuses ambiguous basenames", async () => {
    const onNavigate = vi.fn();
    const view = renderHook(
      () => useMrChatFileNavigation({ ...SCOPE, onNavigate }),
      { wrapper: wrapper() },
    );
    await act(() => view.result.current.onOpenFile("context.ts"));
    expect(snapshot).toHaveBeenCalledWith(SCOPE.repoPath, 7, HEAD, "origin");
    expect(view.result.current.request).toMatchObject({
      path: "src/context.ts",
      kind: "source",
      side: "new",
    });
    act(() =>
      view.result.current.consume(view.result.current.request?.id ?? ""),
    );
    await act(() => view.result.current.onOpenFile("duplicate.ts"));
    expect(view.result.current.request).toBeUndefined();
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith(
      expect.stringMatching(/ambiguous|more than one/i),
    );
  });

  it("opens search results on their exact diff side without scanning other files", async () => {
    const onNavigate = vi.fn();
    const view = renderHook(
      () => useMrChatFileNavigation({ ...SCOPE, onNavigate }),
      { wrapper: wrapper() },
    );
    await act(() => view.result.current.onOpenFile("src/entry.ts:10:3", "old"));
    expect(view.result.current.request).toMatchObject({
      path: "src/entry.ts",
      side: "old",
      line: 10,
      column: 3,
    });
    await act(() => view.result.current.onOpenFile("src/context.ts:1", "new"));
    expect(snapshot).not.toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(view.result.current.request).toBeUndefined();
    expect(toast.info).toHaveBeenCalledWith(
      expect.stringContaining("missing from the loaded MR file list"),
    );
  });

  it.each(["head", "MR", "activation", "file navigation", "invalid link"])(
    "discards an outstanding snapshot lookup after %s changes",
    async (change) => {
      let resolve!: (files: typeof listing) => void;
      snapshot.mockReturnValue(
        new Promise((done) => {
          resolve = done;
        }),
      );
      const onNavigate = vi.fn();
      const view = renderHook(
        (scope) => useMrChatFileNavigation({ ...scope, onNavigate }),
        { initialProps: SCOPE, wrapper: wrapper() },
      );
      let pending!: Promise<void>;
      act(() => {
        pending = view.result.current.onOpenFile("src/context.ts");
      });
      if (change === "head")
        view.rerender({ ...SCOPE, headSha: "c".repeat(40) });
      if (change === "MR")
        view.rerender({ ...SCOPE, mr: { ...SCOPE.mr, number: 8 }, number: 8 });
      if (change === "activation") {
        view.rerender({ ...SCOPE, enabled: false });
        view.rerender(SCOPE);
      }
      if (change === "file navigation")
        act(() => useUiStore.getState().noteUserInteraction());
      if (change === "invalid link")
        await act(() =>
          view.result.current.onOpenFile("/outside/repository.ts"),
        );
      await act(async () => {
        resolve(listing);
        await pending;
      });
      expect(onNavigate).not.toHaveBeenCalled();
      expect(view.result.current.request).toBeUndefined();
    },
  );
});

function FilesHarness() {
  const [path, setPath] = useState("src/entry.ts");
  const navigation = useMrChatFileNavigation({
    ...SCOPE,
    onNavigate: () => undefined,
  });
  return (
    <>
      <PrDiffSearch
        sections={
          new Map(
            SCOPE.changedFiles.map((file) => [file.path, patch(file.path)]),
          )
        }
        enabled
        pending={false}
        failed={false}
        incomplete={false}
        onRetry={() => undefined}
        onSelect={(match) => {
          void navigation.onOpenFile(
            `${encodeURIComponent(match.path)}:${match.line}:${match.column}`,
            match.side,
          );
        }}
      />
      <button
        type="button"
        onClick={() => void navigation.onOpenFile("src/context.ts")}
      >
        Open context from chat
      </button>
      <button
        type="button"
        onClick={() => void navigation.onOpenFile("src/renamed.ts#L10")}
      >
        Open visible line from chat
      </button>
      <button
        type="button"
        onClick={() => void navigation.onOpenFile("src/renamed.ts#L30")}
      >
        Open hidden line from chat
      </button>
      <PrFilesPane
        files={SCOPE.changedFiles.map((file) => ({
          path: file.path,
          additions: 1,
          deletions: 1,
        }))}
        effectivePath={path}
        onSelectPath={setPath}
        fileDiff={{
          filePath: path,
          text: patch(path),
          isBinary: false,
          isTruncated: false,
        }}
        isPending={false}
        isError={false}
        isFetching={false}
        repoPath={SCOPE.repoPath}
        lens="origin"
        number={7}
        blameRev={HEAD}
        provider="gitlab"
        navigationRequest={navigation.request}
        onNavigationConsumed={navigation.consume}
      />
    </>
  );
}

describe("chat navigation through the shared MR file pane", () => {
  it("opens MR search results at the old-side line and reveals their file without an AI session", async () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    render(<FilesHarness />, { wrapper: wrapper() });
    await screen.findByRole("group", { name: "Diff of src/entry.ts" });
    await userEvent.click(
      screen.getByRole("button", { name: "Search MR changes" }),
    );
    await userEvent.type(
      screen.getByRole("searchbox", { name: "Search MR changes" }),
      "line 10",
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: /src\/entry.ts.*Before line 10/,
      }),
    );
    await waitFor(() =>
      expect(
        scroll.mock.instances.some(
          (element) =>
            element instanceof Element &&
            element.matches("tr.diff-line") &&
            element.querySelector(
              '[data-line-old-num="10"], .diff-line-old-num [data-line-num="10"]',
            ),
        ),
      ).toBe(true),
    );
    expect(
      screen.queryByRole("dialog", { name: "Search MR changes" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /entry.ts/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(snapshot).not.toHaveBeenCalled();
  });
  it("reveals unchanged files in All files and preserves the visit in file history", async () => {
    render(<FilesHarness />, { wrapper: wrapper() });
    await userEvent.click(
      screen.getByRole("button", { name: "Open context from chat" }),
    );
    const source = await screen.findByRole("region", {
      name: "Source of src/context.ts",
    });
    await waitFor(() => expect(source).toHaveTextContent("unchanged source"));
    const row = await screen.findByRole("treeitem", { name: /context.ts/ });
    expect(row).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("button", { name: "File scope: All files" }),
    ).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(
      screen.getByRole("button", { name: "Back in file history" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Source of src/context.ts" }),
      ).toBeNull(),
    );
  });

  it("lands a visible line in Diff and uses the same pinned Full file view for an omitted line", async () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    render(<FilesHarness />, { wrapper: wrapper() });
    await userEvent.click(
      screen.getByRole("button", { name: "Open visible line from chat" }),
    );
    await waitFor(() =>
      expect(
        scroll.mock.instances.some(
          (element) =>
            element instanceof Element &&
            element.matches("tr.diff-line") &&
            element.querySelector(
              '[data-line-new-num="10"], .diff-line-new-num [data-line-num="10"]',
            ),
        ),
      ).toBe(true),
    );
    expect(screen.getByRole("button", { name: "Diff" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    scroll.mockClear();
    await userEvent.click(
      screen.getByRole("button", { name: "Open hidden line from chat" }),
    );
    await waitFor(() =>
      expect(
        scroll.mock.instances.some(
          (element) =>
            element instanceof Element &&
            element.matches("tr.diff-line") &&
            element.querySelector(
              '[data-line-new-num="30"], .diff-line-new-num [data-line-num="30"]',
            ),
        ),
      ).toBe(true),
    );
    expect(screen.getByRole("button", { name: "Full file" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(vi.mocked(gitPrSnapshotComparison)).toHaveBeenCalledWith(
      SCOPE.repoPath,
      7,
      HEAD,
      "src/renamed.ts",
      "origin",
    );
  });
});
