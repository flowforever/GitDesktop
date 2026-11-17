import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PrFilesPane } from "@/features/pulls/RemotePrViewParts";
import { gitObjectsPresent } from "@/lib/git/api";
import {
  gitPrSnapshotComparison,
  gitPrSnapshotFile,
  gitPrSnapshotFiles,
} from "@/lib/git/api/pr-snapshot";
import type { FileDiff } from "@/lib/git/types";
import { dispatchAction } from "@/lib/hotkeys/handler-registry";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { stubCanvas } from "./canvas-stub";

const rendering = vi.hoisted(() => ({ defaultDiff: false }));

// Default diffs keep real review anchors without the canvas; Full file uses the
// real renderer so both versions and complete context are observable.
vi.mock("@/features/diff/DiffSurfaceLazy", async () => {
  const { useReportPaneSettled } = await import(
    "@/features/diff/diff-pane-hold"
  );
  const { DiffContent: FullDiff } = await import("@/features/diff/DiffSurface");
  return {
    DiffContent: (props: ComponentProps<typeof FullDiff>) => {
      useReportPaneSettled(true);
      if (props.fullContext || rendering.defaultDiff)
        return <FullDiff {...props} />;
      const { lineAnchors } = props;
      return (
        <>
          {lineAnchors?.map((anchor) => (
            <div key={`${anchor.side}:${anchor.line}`}>{anchor.render()}</div>
          ))}
        </>
      );
    },
  };
});
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitObjectsPresent: vi.fn(),
  // The editor's provider probe is independent of its local unsaved text.
  forgeStatus: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("@/lib/git/api/pr-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api/pr-snapshot")>()),
  gitPrSnapshotFiles: vi.fn(),
  gitPrSnapshotComparison: vi.fn(),
  gitPrSnapshotFile: vi.fn(),
}));

const REPO = "/repo";
const HEAD = "abcdef0123".repeat(4);
const BASE = "fedcba9876".repeat(4);
const NEXT_HEAD = "123456789a".repeat(4);
const PATH = "changed.txt";
const snapshot = vi.mocked(gitPrSnapshotFiles);
const bytes = vi.mocked(gitPrSnapshotFile);
const comparison = vi.mocked(gitPrSnapshotComparison);
const FILES = [
  { path: PATH, additions: 1, deletions: 1 },
  { path: "other.txt", additions: 2, deletions: 0 },
  { path: "deleted.txt", additions: 0, deletions: 2 },
];

// CommentEditor's autofocus scrolls its textarea; jsdom supplies no method.
Element.prototype.scrollIntoView ??= () => undefined;

function patch(path = PATH, deleted = false): FileDiff {
  return {
    filePath: path,
    text: deleted
      ? `diff --git a/${path} b/${path}\ndeleted file mode 100644\n--- a/${path}\n+++ /dev/null\n@@ -1 +0,0 @@\n-removed\n`
      : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-before\n+after\n`,
    isBinary: false,
    isTruncated: false,
  };
}

function fileBytes(text: string) {
  return { base64: btoa(text), mime: null, tooLarge: false, size: text.length };
}
const NATIVE_PATCH = `diff --git a/old-blob b/new-blob\n--- a/old-blob\n+++ b/new-blob\n@@ -1,3 +1,3 @@\n prefix\n-before\n+after\n suffix\n`;
const clients: QueryClient[] = [];
beforeAll(stubCanvas);
beforeEach(() => {
  vi.clearAllMocks();
  rendering.defaultDiff = false;
  onlineManager.setOnline(true);
  vi.mocked(gitObjectsPresent).mockResolvedValue(false);
  snapshot.mockResolvedValue([
    { path: PATH, undecodable: false },
    { path: "other.txt", undecodable: false },
  ]);
  comparison.mockReset().mockResolvedValue({
    baseSha: BASE,
    headSha: HEAD,
    oldPath: PATH,
    newPath: PATH,
    before: fileBytes("prefix\nbefore\nsuffix\n"),
    after: fileBytes("prefix\nafter\nsuffix\n"),
    patch: NATIVE_PATCH,
  });
  bytes.mockResolvedValue({
    base64: btoa("complete MR head source"),
    mime: null,
    tooLarge: false,
    size: 23,
  });
});
afterEach(() => {
  if (vi.isMockFunction(Element.prototype.scrollIntoView))
    vi.mocked(Element.prototype.scrollIntoView).mockRestore();
  if (vi.isMockFunction(HTMLElement.prototype.getBoundingClientRect))
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockRestore();
  for (const client of clients.splice(0)) client.clear();
  onlineManager.setOnline(true);
  document
    .querySelectorAll("[data-test-line-composer]")
    .forEach((node) => node.remove());
});

type Props = ComponentProps<typeof PrFilesPane>;

function mountPane(
  overrides: Partial<Props> = {},
  mode: "split" | "unified" = "unified",
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  client.setQueryData(settingsKeys.settings, {
    ...DEFAULT_SETTINGS,
    diffViewMode: mode,
  });
  let props: Props = {
    files: FILES,
    effectivePath: PATH,
    onSelectPath: vi.fn(),
    fileDiff: patch(),
    isPending: false,
    isError: false,
    isFetching: false,
    repoPath: REPO,
    lens: "origin",
    number: 7,
    blameRev: HEAD,
    provider: "gitlab",
    ...overrides,
  };
  const view = render(<PrFilesPane {...props} />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return {
    ...view,
    client,
    props,
    update(next: Partial<Props>) {
      props = { ...props, ...next };
      view.rerender(<PrFilesPane {...props} />);
    },
  };
}

async function fullSource() {
  await waitFor(() => {
    const full = screen.getByRole("region", {
      name: `Full comparison of ${PATH}`,
    });
    const rendered = within(full).getByRole("group", {
      name: `Diff of ${PATH}`,
    });
    expect(rendered).toHaveTextContent("prefix");
    expect(rendered).toHaveTextContent("before");
    expect(rendered).toHaveTextContent("after");
    expect(rendered).toHaveTextContent("suffix");
  });
}

function separatedChanges(lines = 18) {
  const before = Array.from(
    { length: lines },
    (_, index) => `context-${index}`,
  );
  const after = [...before];
  before[3] = "first-old";
  after[3] = "first-new";
  before[6] = after[6] = "-literal-context";
  before[7] = after[7] = "+literal-context";
  const second = lines - 4;
  before[second] = "second-old";
  after[second] = "second-new";
  const rows = before.flatMap((line, index) =>
    line === after[index] ? [` ${line}`] : [`-${line}`, `+${after[index]}`],
  );
  return {
    before: fileBytes(`${before.join("\n")}\n`),
    after: fileBytes(`${after.join("\n")}\n`),
    patch: `diff --git a/old-blob b/new-blob\n--- a/old-blob\n+++ b/new-blob\n@@ -1,${lines} +1,${lines} @@\n${rows.join("\n")}\n`,
  };
}

describe("changed-file full source", () => {
  it("defaults to Diff without preparing a head or reading file bytes", () => {
    const view = mountPane();

    expect(screen.getByRole("button", { name: "Diff" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Full file" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(snapshot).not.toHaveBeenCalled();
    expect(comparison).not.toHaveBeenCalled();
    expect(view.props.onSelectPath).not.toHaveBeenCalled();
  });

  it("prepares the exact unfetched MR head before reading only the selected file", async () => {
    let resolveHead!: (
      files: Awaited<ReturnType<typeof gitPrSnapshotFiles>>,
    ) => void;
    snapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHead = resolve;
        }),
    );
    const view = mountPane();
    await userEvent.click(screen.getByRole("button", { name: "Full file" }));

    expect(snapshot).toHaveBeenCalledExactlyOnceWith(REPO, 7, HEAD, "origin");
    expect(comparison).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Full file" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await act(async () => resolveHead([{ path: PATH, undecodable: false }]));
    await fullSource();

    expect(comparison).toHaveBeenCalledExactlyOnceWith(
      REPO,
      7,
      HEAD,
      PATH,
      "origin",
    );
    expect(
      screen.queryByRole("region", { name: `Source of ${PATH}` }),
    ).toBeNull();
    expect(bytes).not.toHaveBeenCalled();
    expect(screen.queryByText("No MR changes")).toBeNull();
    expect(view.props.onSelectPath).not.toHaveBeenCalled();
  });

  it("switches back to Diff without changing selection and reuses the prepared source cache", async () => {
    const user = userEvent.setup();
    const view = mountPane();
    await user.click(screen.getByRole("button", { name: "Full file" }));
    await fullSource();
    await user.click(screen.getByRole("button", { name: "Diff" }));

    expect(screen.getByRole("button", { name: "Diff" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.queryByRole("region", { name: `Full comparison of ${PATH}` }),
    ).toBeNull();
    expect(view.props.onSelectPath).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Full file" }));
    await fullSource();
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(comparison).toHaveBeenCalledTimes(1);
  });

  it.each([
    { lens: "upstream" as const },
    { number: 8 },
    { blameRev: NEXT_HEAD },
    { repoPath: "/another-repo" },
    { effectivePath: "other.txt", fileDiff: patch("other.txt") },
  ])(
    "returns to Diff when the file or MR identity changes: %j",
    async (next) => {
      const view = mountPane();
      await userEvent.click(screen.getByRole("button", { name: "Full file" }));
      await fullSource();

      view.update(next);

      expect(screen.getByRole("button", { name: "Diff" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(
        screen.queryByRole("region", { name: `Full comparison of ${PATH}` }),
      ).toBeNull();
      expect(snapshot).toHaveBeenCalledTimes(1);
      expect(comparison).toHaveBeenCalledExactlyOnceWith(
        REPO,
        7,
        HEAD,
        PATH,
        "origin",
      );
    },
  );

  it("offers retry when head preparation fails and leaves Diff reachable", async () => {
    snapshot.mockRejectedValueOnce(new Error("Head fetch unavailable"));
    mountPane();
    await userEvent.click(screen.getByRole("button", { name: "Full file" }));
    const retry = await screen.findByRole("button", {
      name: "Retry loading full file",
    });

    expect(comparison).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Diff" })).toBeEnabled();
    await userEvent.click(retry);
    await fullSource();
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(comparison).toHaveBeenCalledExactlyOnceWith(
      REPO,
      7,
      HEAD,
      PATH,
      "origin",
    );
  });

  it("shows an explicit offline state instead of fetching source before head preparation", async () => {
    onlineManager.setOnline(false);
    mountPane();
    await userEvent.click(screen.getByRole("button", { name: "Full file" }));

    expect(
      await screen.findByText(
        "You're offline — this file will load once you're back online.",
      ),
    ).toBeVisible();
    expect(snapshot).not.toHaveBeenCalled();
    expect(comparison).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Diff" }));
    expect(screen.getByRole("button", { name: "Diff" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("shows the complete real before version for a deleted file with an absent after side", async () => {
    comparison.mockResolvedValueOnce({
      baseSha: BASE,
      headSha: HEAD,
      oldPath: "deleted.txt",
      newPath: null,
      before: fileBytes("removed-one\nremoved-two\n"),
      after: null,
      patch: null,
    });
    mountPane({
      effectivePath: "deleted.txt",
      fileDiff: patch("deleted.txt", true),
    });
    await userEvent.click(screen.getByRole("button", { name: "Full file" }));

    await waitFor(() => {
      const full = screen.getByRole("region", {
        name: "Full comparison of deleted.txt",
      });
      expect(full).toHaveTextContent("removed-one");
      expect(full).toHaveTextContent("removed-two");
    });
    expect(comparison).toHaveBeenCalledExactlyOnceWith(
      REPO,
      7,
      HEAD,
      "deleted.txt",
      "origin",
    );
    expect(bytes).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Diff" }));
    expect(screen.getByRole("button", { name: "Diff" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("holds Full file while a line-comment draft is open and rechecks at activation", async () => {
    mountPane();
    const full = screen.getByRole("button", { name: "Full file" });
    const composer = document.createElement("div");
    composer.dataset.diffLineWidget = "layout";
    composer.dataset.testLineComposer = "true";
    const draft = document.createElement("textarea");
    draft.value = "Keep this line-comment draft";
    composer.append(draft);
    document.body.append(composer);

    fireEvent.click(full);

    expect(full).toHaveAttribute("aria-pressed", "false");
    expect(snapshot).not.toHaveBeenCalled();
    expect(comparison).not.toHaveBeenCalled();
    expect(draft.value).toBe("Keep this line-comment draft");
    await waitFor(() => expect(full).toHaveAttribute("aria-disabled", "true"));
    expect(full).toHaveAccessibleDescription(/line comment/);
    composer.remove();
    await waitFor(() =>
      expect(full).not.toHaveAttribute("aria-disabled", "true"),
    );
    await userEvent.click(full);
    await fullSource();
  });

  it("holds Full file when the MR head metadata is unavailable", () => {
    mountPane({ blameRev: undefined });
    expect(screen.getByRole("button", { name: "Full file" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(snapshot).not.toHaveBeenCalled();
    expect(comparison).not.toHaveBeenCalled();
  });

  it("preserves unsaved edits to a real pending-review draft until the editor is closed", async () => {
    const user = userEvent.setup();
    mountPane({
      drafts: [
        {
          id: "draft-one",
          path: PATH,
          line: 1,
          side: "new",
          body: "Saved pending comment",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("textbox", {
      name: "Edit pending comment",
    });
    await waitFor(() => expect(editor).toHaveFocus());
    await user.clear(editor);
    await user.type(editor, "Unsaved pending-comment revision");
    const full = screen.getByRole("button", { name: "Full file" });

    await user.click(full);
    act(() => dispatchAction("pr-toggle-full-file"));

    expect(
      screen.getByRole("textbox", { name: "Edit pending comment" }),
    ).toHaveValue("Unsaved pending-comment revision");
    expect(full).toHaveAttribute("aria-pressed", "false");
    expect(full).toHaveAttribute("aria-disabled", "true");
    expect(full).toHaveAccessibleDescription(/line comment/);
    expect(snapshot).not.toHaveBeenCalled();
    expect(comparison).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(full).not.toHaveAttribute("aria-disabled", "true"),
    );
    await user.click(full);
    await fullSource();
    await user.click(screen.getByRole("button", { name: "Diff" }));

    expect(await screen.findByText("Saved pending comment")).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit" })).toBeVisible();
  });

  it("dispatches file-view palette actions only while this request is interactive", async () => {
    const view = mountPane();
    const expand = screen.queryByRole("button", { name: "Expand file list" });
    if (expand) await userEvent.click(expand);

    act(() => dispatchAction("pr-toggle-all-files"));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "File scope: All files" }),
      ).toHaveAttribute("aria-pressed", "true"),
    );
    act(() => dispatchAction("pr-toggle-full-file"));
    await fullSource();

    view.update({ interactionEnabled: false });
    act(() => {
      dispatchAction("pr-toggle-all-files");
      dispatchAction("pr-toggle-full-file");
    });

    expect(
      screen.getByRole("button", { name: "File scope: All files" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Full file" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(view.props.onSelectPath).not.toHaveBeenCalled();
    view.update({ interactionEnabled: true });
    act(() => dispatchAction("pr-toggle-full-file"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Diff" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
  });

  it.each(["unified", "split"] as const)(
    "navigates separate real change blocks inside one complete %s hunk",
    async (mode) => {
      comparison.mockResolvedValueOnce({
        baseSha: BASE,
        headSha: HEAD,
        oldPath: PATH,
        newPath: PATH,
        ...separatedChanges(),
      });
      const view = mountPane({}, mode);
      await userEvent.click(screen.getByRole("button", { name: "Full file" }));
      const full = await screen.findByRole("region", {
        name: `Full comparison of ${PATH}`,
      });
      await waitFor(() => expect(full).toHaveTextContent("second-new"));
      const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
      const previous = screen.getByRole("button", { name: "Previous change" });
      const next = screen.getByRole("button", { name: "Next change" });
      await waitFor(() =>
        expect(next).not.toHaveAttribute("aria-disabled", "true"),
      );

      await userEvent.click(next);

      expect(scroll.mock.contexts.at(-1)).toHaveTextContent("first-old");
      act(() => dispatchAction("diff-next-change"));
      expect(scroll.mock.contexts.at(-1)).toHaveTextContent("second-old");
      expect(next).toHaveAttribute("aria-disabled", "true");
      await userEvent.click(previous);
      expect(scroll.mock.contexts.at(-1)).toHaveTextContent("first-old");
      expect(previous).toHaveAttribute("aria-disabled", "true");
      expect(view.props.onSelectPath).not.toHaveBeenCalled();

      view.update({ interactionEnabled: false });
      scroll.mockClear();
      act(() => dispatchAction("diff-next-change"));
      fireEvent.click(next);
      expect(scroll).not.toHaveBeenCalled();
      scroll.mockRestore();
    },
  );

  it("explains capped change navigation and discovers later blocks after Show full diff", async () => {
    rendering.defaultDiff = true;
    const complete = separatedChanges(350);
    mountPane({
      fileDiff: { ...patch(), text: complete.patch },
    });
    const expand = await screen.findByRole("button", {
      name: "Show full diff",
    });
    const next = screen.getByRole("button", { name: "Next change" });
    await waitFor(() =>
      expect(next).not.toHaveAttribute("aria-disabled", "true"),
    );
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    await userEvent.click(next);

    expect(scroll.mock.contexts.at(-1)).toHaveTextContent("first-old");
    expect(next).toHaveAttribute("aria-disabled", "true");
    expect(next).toHaveAccessibleDescription(/Show full diff/);
    act(() => dispatchAction("diff-next-change"));
    expect(scroll.mock.contexts.at(-1)).toHaveTextContent("first-old");

    await userEvent.click(expand);
    await waitFor(() =>
      expect(next).not.toHaveAttribute("aria-disabled", "true"),
    );
    await userEvent.click(next);

    expect(scroll.mock.contexts.at(-1)).toHaveTextContent("second-old");
    scroll.mockRestore();
  });

  it.each(["unified", "split"] as const)(
    "keeps the logical change position after rebuilding %s into the other layout",
    async (mode) => {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        bottom: 800,
        right: 1200,
        width: 1200,
        height: 800,
        toJSON: () => ({}),
      });
      comparison.mockResolvedValueOnce({
        baseSha: BASE,
        headSha: HEAD,
        oldPath: PATH,
        newPath: PATH,
        ...separatedChanges(),
      });
      const view = mountPane({}, mode);
      await userEvent.click(screen.getByRole("button", { name: "Full file" }));
      const full = await screen.findByRole("region", {
        name: `Full comparison of ${PATH}`,
      });
      await waitFor(() => expect(full).toHaveTextContent("second-new"));
      const next = screen.getByRole("button", { name: "Next change" });
      await waitFor(() =>
        expect(next).not.toHaveAttribute("aria-disabled", "true"),
      );
      const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
      await userEvent.click(next);
      await userEvent.click(next);
      expect(scroll.mock.contexts.at(-1)).toHaveTextContent("second-old");

      const otherMode = mode === "unified" ? "split" : "unified";
      await act(async () => {
        view.client.setQueryData(settingsKeys.settings, {
          ...DEFAULT_SETTINGS,
          diffViewMode: otherMode,
        });
      });
      await waitFor(() => {
        const rendered = within(full).getByRole("group", {
          name: `Diff of ${PATH}`,
        });
        expect(rendered).toHaveTextContent("second-new");
        expect(
          rendered.querySelector("td.diff-line-old-content") !== null,
        ).toBe(otherMode === "split");
      });

      expect(next).toHaveAttribute("aria-disabled", "true");
      scroll.mockClear();
      act(() => dispatchAction("diff-next-change"));
      expect(scroll).not.toHaveBeenCalled();
      await userEvent.click(
        screen.getByRole("button", { name: "Previous change" }),
      );
      expect(scroll.mock.contexts.at(-1)).toHaveTextContent("first-old");
      expect(
        screen.getByRole("button", { name: "Previous change" }),
      ).toHaveAttribute("aria-disabled", "true");
      scroll.mockRestore();
    },
  );

  it("keeps held and preparing file slots out of change navigation", async () => {
    rendering.defaultDiff = true;
    const complete = separatedChanges();
    let resolveHead!: (
      files: Awaited<ReturnType<typeof gitPrSnapshotFiles>>,
    ) => void;
    snapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHead = resolve;
        }),
    );
    mountPane({ fileDiff: { ...patch(), text: complete.patch } });
    const next = screen.getByRole("button", { name: "Next change" });
    await waitFor(() =>
      expect(next).not.toHaveAttribute("aria-disabled", "true"),
    );
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");

    await userEvent.click(screen.getByRole("button", { name: "Full file" }));
    const fullNext = screen.getByRole("button", { name: "Next change" });
    await waitFor(() =>
      expect(fullNext).toHaveAttribute("aria-disabled", "true"),
    );
    scroll.mockClear();
    fireEvent.click(fullNext);
    act(() => dispatchAction("diff-next-change"));

    expect(scroll).not.toHaveBeenCalled();
    await act(async () => resolveHead([{ path: PATH, undecodable: false }]));
    await fullSource();
    await waitFor(() =>
      expect(fullNext).not.toHaveAttribute("aria-disabled", "true"),
    );
    await userEvent.click(fullNext);
    expect(scroll.mock.contexts.at(-1)).toHaveTextContent("before");
    scroll.mockRestore();
  });

  it("routes changed-file controls through the active-request and live draft guards", async () => {
    const view = mountPane();
    const expand = screen.queryByRole("button", { name: "Expand file list" });
    if (expand) await userEvent.click(expand);
    const next = screen.getByRole("button", { name: "Next changed file" });

    await userEvent.click(next);
    expect(view.props.onSelectPath).toHaveBeenCalledExactlyOnceWith(
      "deleted.txt",
    );
    vi.mocked(view.props.onSelectPath).mockClear();
    view.update({ interactionEnabled: false });
    act(() => dispatchAction("pr-next-changed-file"));
    fireEvent.click(next);
    expect(view.props.onSelectPath).not.toHaveBeenCalled();

    view.update({ interactionEnabled: true });
    const composer = document.createElement("div");
    composer.dataset.diffLineWidget = "layout";
    composer.dataset.testLineComposer = "true";
    document.body.append(composer);
    fireEvent.click(next);
    act(() => dispatchAction("pr-next-changed-file"));

    expect(view.props.onSelectPath).not.toHaveBeenCalled();
    await waitFor(() => expect(next).toBeDisabled());
  });

  it.each([{ provider: "github" as const }, { lens: "upstream" as const }])(
    "explains why a comparison is unavailable for %j",
    (unsupported) => {
      mountPane(unsupported);
      const full = screen.getByRole("button", { name: "Full file" });

      expect(full).toHaveAttribute("aria-disabled", "true");
      expect(full).toHaveAccessibleDescription(/GitLab.*origin/);
      act(() => dispatchAction("pr-toggle-full-file"));
      expect(full).toHaveAttribute("aria-pressed", "false");
      expect(snapshot).not.toHaveBeenCalled();
      expect(comparison).not.toHaveBeenCalled();
    },
  );

  it("refreshes request data and the native pair when comparison loading fails", async () => {
    const onRetry = vi.fn();
    comparison.mockRejectedValueOnce(
      new Error("MR head moved; refresh the request"),
    );
    mountPane({ onRetry });
    await userEvent.click(screen.getByRole("button", { name: "Full file" }));
    const retry = await screen.findByRole("button", {
      name: "Retry full comparison",
    });

    await userEvent.click(retry);
    await fullSource();

    expect(onRetry).toHaveBeenCalledOnce();
    expect(comparison).toHaveBeenCalledTimes(2);
    expect(bytes).not.toHaveBeenCalled();
  });

  it("refuses oversized versions without falling back to a head-only file", async () => {
    comparison.mockResolvedValueOnce({
      baseSha: BASE,
      headSha: HEAD,
      oldPath: PATH,
      newPath: PATH,
      before: { base64: null, mime: null, tooLarge: true, size: 20_000_001 },
      after: fileBytes("after"),
      patch: null,
    });
    mountPane();
    await userEvent.click(screen.getByRole("button", { name: "Full file" }));

    expect(
      await screen.findByText(
        "Full comparison is too large to display safely. Use Diff to review its changes.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("region", { name: `Source of ${PATH}` }),
    ).toBeNull();
    expect(bytes).not.toHaveBeenCalled();
  });
});
