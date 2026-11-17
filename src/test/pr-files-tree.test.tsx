import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { PrFilesTree, type PrTreeFile } from "@/features/pulls/PrFilesTree";
import { PrFilesPane } from "@/features/pulls/RemotePrViewParts";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";

vi.mock("@/features/diff/DiffSurfaceLazy", () => ({
  DiffContent: () => null,
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitObjectsPresent: vi.fn(async () => false),
}));

// jsdom has no scrolling implementation; tree navigation scrolls focused rows.
Element.prototype.scrollIntoView ??= () => undefined;

const LONG_NAME =
  "merge-request-file-with-a-name-that-needs-horizontal-scrolling.test.tsx";
const LONG_PATH = `src/features/${LONG_NAME}`;
const FILES = [
  { path: "README.md", additions: 3, deletions: 1 },
  { path: "src/features/z-last.ts", additions: 12, deletions: 4 },
  { path: LONG_PATH, additions: 2, deletions: 0 },
  { path: "assets/logo.bin", additions: 0, deletions: 0 },
];

const SCOPE_FILES: PrTreeFile[] = [
  { path: "README.md", additions: 1, deletions: 0 },
  { path: "src/changed.ts", additions: 1, deletions: 0 },
  { path: "src/nested/child.ts", additions: 1, deletions: 0 },
  { path: "src/nested/deeper/grandchild.ts", additions: 1, deletions: 0 },
];

function mountScopedTree(files: PrTreeFile[], allFiles: boolean) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
  const onSelectPath = vi.fn();
  const tree = (nextFiles: PrTreeFile[], nextAllFiles: boolean) => (
    <QueryClientProvider client={client}>
      <PrFilesTree
        files={nextFiles}
        allFiles={nextAllFiles}
        effectivePath="README.md"
        onSelectPath={onSelectPath}
      />
    </QueryClientProvider>
  );
  const view = render(tree(files, allFiles));
  return {
    onSelectPath,
    update: (nextFiles: PrTreeFile[], nextAllFiles: boolean) =>
      view.rerender(tree(nextFiles, nextAllFiles)),
  };
}

function mountRevealTree(files: PrTreeFile[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
  const onSelectPath = vi.fn();
  let state: {
    files: PrTreeFile[];
    allFiles: boolean;
    effectivePath: string;
    revealRequest?: { path: string; id: number };
  } = { files, allFiles: true, effectivePath: "README.md" };
  const tree = () => (
    <QueryClientProvider client={client}>
      <PrFilesTree
        {...state}
        onSelectPath={onSelectPath}
        header={<button type="button">Next changed file</button>}
      />
    </QueryClientProvider>
  );
  const view = render(tree());
  return {
    onSelectPath,
    update: (next: Partial<typeof state>) => {
      state = { ...state, ...next };
      view.rerender(tree());
    },
  };
}

function FilesHarness({ withActions = false }: { withActions?: boolean }) {
  const [path, setPath] = useState<string | null>(LONG_PATH);
  return (
    <>
      <output aria-label="Selected file">{path}</output>
      <PrFilesPane
        files={FILES}
        binaryPaths={new Set(["assets/logo.bin"])}
        effectivePath={path}
        onSelectPath={setPath}
        fileDiff={undefined}
        isPending={false}
        isError={false}
        isFetching={false}
        repoPath={withActions ? "/repo" : undefined}
        blameRev={withActions ? "head-sha" : undefined}
      />
    </>
  );
}

async function mount(withActions = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
  render(
    <QueryClientProvider client={client}>
      <FilesHarness withActions={withActions} />
    </QueryClientProvider>,
  );
  // A zero-width jsdom rail is narrow, so expand its existing local override.
  const expand = screen.queryByRole("button", { name: "Expand file list" });
  if (expand) await userEvent.click(expand);
}

const fileRow = (name: string) =>
  screen.getByRole("treeitem", { name: new RegExp(name) });
const folderRow = (name: string) =>
  screen.getByRole("treeitem", { name, expanded: true });

describe("pull request file tree", () => {
  it("reveals a requested file through only its closed ancestors without taking header focus", async () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    try {
      const target = "src/nested/deeper/grandchild.ts";
      const { update, onSelectPath } = mountRevealTree([
        ...SCOPE_FILES,
        { path: "docs/guide.md", sourceOnly: true },
        { path: "src/unrelated/keep.ts", sourceOnly: true },
      ]);
      const next = screen.getByRole("button", { name: "Next changed file" });
      await userEvent.click(next);

      update({ effectivePath: target, revealRequest: { path: target, id: 1 } });

      const selected = fileRow("grandchild.ts");
      expect(selected).toHaveAttribute("aria-selected", "true");
      expect(selected).toHaveAttribute("tabindex", "0");
      expect(folderRow("src")).toBeInTheDocument();
      expect(folderRow("nested")).toBeInTheDocument();
      expect(folderRow("deeper")).toBeInTheDocument();
      for (const name of ["docs", "unrelated"])
        expect(
          screen.getByRole("treeitem", { name, expanded: false }),
        ).toBeInTheDocument();
      expect(scroll.mock.contexts).toContain(selected);
      expect(scroll.mock.contexts).toContain(
        within(selected).getByText("grandchild.ts"),
      );
      expect(scroll).toHaveBeenLastCalledWith({
        block: "nearest",
        inline: "nearest",
      });
      expect(next).toHaveFocus();
      expect(onSelectPath).not.toHaveBeenCalled();
    } finally {
      scroll.mockRestore();
    }
  });

  it("reveals the same selected path again on a new request after manual collapse", async () => {
    const target = "src/nested/deeper/grandchild.ts";
    const { update, onSelectPath } = mountRevealTree([
      ...SCOPE_FILES,
      { path: "docs/guide.md", sourceOnly: true },
    ]);
    await userEvent.click(screen.getByRole("treeitem", { name: "docs" }));
    update({ effectivePath: target, revealRequest: { path: target, id: 1 } });
    expect(fileRow("grandchild.ts")).toBeInTheDocument();

    await userEvent.click(folderRow("src"));

    expect(screen.queryByText("grandchild.ts")).not.toBeInTheDocument();
    const next = screen.getByRole("button", { name: "Next changed file" });
    await userEvent.click(next);
    update({ revealRequest: { path: target, id: 2 } });

    expect(fileRow("grandchild.ts")).toHaveAttribute("tabindex", "0");
    expect(folderRow("docs")).toBeInTheDocument();
    expect(next).toHaveFocus();
    expect(onSelectPath).not.toHaveBeenCalled();
  });

  it("does not reveal ordinary selection changes or replay a consumed request across scopes", async () => {
    const target = "src/nested/deeper/grandchild.ts";
    const { update, onSelectPath } = mountRevealTree(SCOPE_FILES);
    update({ effectivePath: target });
    expect(screen.queryByText("grandchild.ts")).not.toBeInTheDocument();

    update({ revealRequest: { path: target, id: 1 } });
    expect(fileRow("grandchild.ts")).toBeInTheDocument();
    for (const allFiles of [false, true]) {
      update({ allFiles });
      expect(
        screen.getByRole("treeitem", { name: "src", expanded: false }),
      ).toBeInTheDocument();
      expect(screen.queryByText("grandchild.ts")).not.toBeInTheDocument();
    }
    expect(onSelectPath).not.toHaveBeenCalled();
  });

  it("consumes missing-file requests without replaying them when files arrive", () => {
    const target = "late/arriving.ts";
    const { update, onSelectPath } = mountRevealTree(SCOPE_FILES);
    update({ effectivePath: target, revealRequest: { path: target, id: 1 } });
    update({
      files: [...SCOPE_FILES, { path: target, additions: 1, deletions: 0 }],
    });
    expect(
      screen.getByRole("treeitem", { name: "late", expanded: false }),
    ).toBeInTheDocument();
    expect(screen.queryByText("arriving.ts")).not.toBeInTheDocument();

    update({ revealRequest: { path: target, id: 2 } });

    expect(fileRow("arriving.ts")).toHaveAttribute("tabindex", "0");
    expect(
      screen.getByRole("treeitem", { name: "src", expanded: false }),
    ).toBeInTheDocument();
    expect(onSelectPath).not.toHaveBeenCalled();
  });

  it("mounts and scrolls an offscreen requested file while keeping header focus", async () => {
    const height = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(560);
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(288);
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    try {
      const files = Array.from({ length: 3000 }, (_, index) => ({
        path: `folder-${String(index).padStart(4, "0")}/file.ts`,
        additions: 1,
        deletions: 0,
      }));
      const target = files[files.length - 1].path;
      const { update, onSelectPath } = mountRevealTree(files);
      const next = screen.getByRole("button", { name: "Next changed file" });
      await userEvent.click(next);

      update({ effectivePath: target, revealRequest: { path: target, id: 1 } });

      const selected = fileRow("folder-2999.*file.ts");
      expect(selected).toHaveAttribute("tabindex", "0");
      expect(scroll.mock.contexts).toContain(selected);
      expect(scroll.mock.contexts).toContain(
        within(selected).getByText("file.ts"),
      );
      expect(scroll).toHaveBeenLastCalledWith({
        block: "nearest",
        inline: "nearest",
      });
      expect(next).toHaveFocus();
      expect(screen.getAllByRole("treeitem").length).toBeLessThan(100);
      expect(onSelectPath).not.toHaveBeenCalled();
    } finally {
      height.mockRestore();
      width.mockRestore();
      scroll.mockRestore();
    }
  });

  it("keeps a revealed file in view after a collapsed tree first becomes virtualized", async () => {
    const height = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(560);
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(288);
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return (
          Number.parseFloat(
            (this.firstElementChild as HTMLElement | null)?.style.height ?? "0",
          ) || 0
        );
      });
    const previousScrollTo = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollTo",
    );
    // Model native scrolling and its scroll-height clamp. The virtualizer writes
    // its initial offset when its scroll element connects, after the first render.
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value(this: HTMLElement, options: ScrollToOptions) {
        this.scrollTop = Math.max(
          0,
          Math.min(
            options.top ?? this.scrollTop,
            this.scrollHeight - this.clientHeight,
          ),
        );
      },
    });
    const scroll = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(function (this: Element) {
        const viewport = this.closest<HTMLElement>(".overflow-auto");
        const row = this.closest<HTMLElement>("[data-file-tree-key]");
        if (!viewport || !row) return;
        const start = Number(
          row.style.transform.match(/translateY\(([\d.]+)px\)/)?.[1] ?? 0,
        );
        const end = start + Number.parseFloat(row.style.height);
        if (start < viewport.scrollTop) viewport.scrollTop = start;
        else if (end > viewport.scrollTop + viewport.clientHeight)
          viewport.scrollTop = end - viewport.clientHeight;
      });
    try {
      const files: PrTreeFile[] = [
        { path: "README.md", sourceOnly: true },
        ...Array.from({ length: 400 }, (_, index) => ({
          path: `src/group-${index % 2}/changed-file-${String(index).padStart(4, "0")}.ts`,
          additions: 1,
          deletions: 0,
        })),
        ...Array.from({ length: 2500 }, (_, index) => ({
          path: `lib/source-${index}.ts`,
          sourceOnly: true as const,
        })),
      ];
      const target = "src/group-1/changed-file-0399.ts";
      const { update, onSelectPath } = mountRevealTree(files);
      expect(screen.getAllByRole("treeitem")).toHaveLength(3);
      const next = screen.getByRole("button", { name: "Next changed file" });
      await userEvent.click(next);

      update({ effectivePath: target, revealRequest: { path: target, id: 1 } });

      await waitFor(() => {
        const row = fileRow("changed-file-0399.ts");
        const viewport = row.closest<HTMLElement>(".overflow-auto");
        expect(viewport).not.toBeNull();
        const start = Number(
          row.style.transform.match(/translateY\(([\d.]+)px\)/)?.[1],
        );
        const top = start - (viewport?.scrollTop ?? 0);
        expect(viewport?.scrollTop).toBeGreaterThan(0);
        expect(top).toBeGreaterThanOrEqual(0);
        expect(top + 28).toBeLessThanOrEqual(viewport?.clientHeight ?? 0);
      });
      expect(next).toHaveFocus();
      expect(onSelectPath).not.toHaveBeenCalled();
    } finally {
      height.mockRestore();
      width.mockRestore();
      scrollHeight.mockRestore();
      scroll.mockRestore();
      if (previousScrollTo)
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollTo",
          previousScrollTo,
        );
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    }
  });

  it("marks every changed ancestor in All files while leaving source-only branches plain", async () => {
    const files: PrTreeFile[] = [
      { path: "README.md", sourceOnly: true },
      { path: "src/keep.ts", sourceOnly: true },
      { path: "src/features/keep.ts", sourceOnly: true },
      { path: "src/features/deeper/changed.ts", additions: 2, deletions: 0 },
      { path: "src/elsewhere/keep.ts", sourceOnly: true },
      { path: "docs/guide.md", sourceOnly: true },
      { path: "assets/icons/logo.bin", additions: 0, deletions: 0 },
      { path: "removed/nested/deleted.ts", additions: 0, deletions: 4 },
    ];
    const { update, onSelectPath } = mountScopedTree(files, true);
    const expectMarkedFolder = (name: string, expanded = false) => {
      const folder = screen.getByRole("treeitem", { name, expanded });
      expect(folder).toHaveAttribute("aria-description", "Contains MR changes");
      expect(within(folder).getByText("Changes")).toBeVisible();
      return folder;
    };
    const expectPlainFolder = (name: string) => {
      const folder = screen.getByRole("treeitem", { name, expanded: false });
      expect(folder).not.toHaveAttribute("aria-description");
      expect(within(folder).queryByText("Changes")).not.toBeInTheDocument();
    };

    const src = expectMarkedFolder("src");
    expectMarkedFolder("assets/icons");
    expectMarkedFolder("removed/nested");
    expectPlainFolder("docs");
    expect(screen.queryByText("changed.ts")).not.toBeInTheDocument();

    await userEvent.click(src);

    expectMarkedFolder("src", true);
    const features = expectMarkedFolder("features");
    expectPlainFolder("elsewhere");
    await userEvent.click(features);
    expectMarkedFolder("features", true);
    const deeper = expectMarkedFolder("deeper");
    await userEvent.click(deeper);
    expectMarkedFolder("deeper", true);
    expect(screen.getByText("changed.ts")).toBeInTheDocument();
    expect(onSelectPath).not.toHaveBeenCalled();

    update(
      files.filter((file) => !file.sourceOnly),
      false,
    );

    expect(screen.queryByText("Changes")).not.toBeInTheDocument();
    for (const row of screen.getAllByRole("treeitem"))
      expect(row).not.toHaveAttribute("aria-description");
    expect(onSelectPath).not.toHaveBeenCalled();
  });

  it("starts All files closed and expands one directory level without selecting files", async () => {
    const { onSelectPath } = mountScopedTree(SCOPE_FILES, true);
    const src = screen.getByRole("treeitem", { name: "src", expanded: false });
    expect(screen.queryByText("changed.ts")).not.toBeInTheDocument();

    await userEvent.click(src);

    expect(src).toHaveAttribute("aria-expanded", "true");
    const nested = screen.getByRole("treeitem", {
      name: "nested",
      expanded: false,
    });
    expect(screen.getByText("changed.ts")).toBeInTheDocument();
    expect(screen.queryByText("child.ts")).not.toBeInTheDocument();
    expect(onSelectPath).not.toHaveBeenCalled();

    await userEvent.click(nested);

    expect(
      screen.getByRole("treeitem", { name: "deeper", expanded: false }),
    ).toBeInTheDocument();
    expect(screen.getByText("child.ts")).toBeInTheDocument();
    expect(screen.queryByText("grandchild.ts")).not.toBeInTheDocument();
    expect(fileRow("README.md")).toHaveAttribute("aria-selected", "true");
    expect(onSelectPath).not.toHaveBeenCalled();
  });

  it("starts with closed directories after switching in either scope direction", async () => {
    const { update, onSelectPath } = mountScopedTree(SCOPE_FILES, false);
    expect(folderRow("src")).toBeInTheDocument();
    expect(folderRow("nested")).toBeInTheDocument();

    update(SCOPE_FILES, true);

    expect(
      screen.getByRole("treeitem", { name: "src", expanded: false }),
    ).toBeInTheDocument();
    expect(screen.queryByText("changed.ts")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("treeitem", { name: "src" }));
    expect(screen.getByText("changed.ts")).toBeInTheDocument();

    update(SCOPE_FILES, false);

    expect(
      screen.getByRole("tree", { name: "Changed files" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("treeitem", { name: "src", expanded: false }),
    ).toBeInTheDocument();
    expect(screen.queryByText("changed.ts")).not.toBeInTheDocument();
    expect(onSelectPath).not.toHaveBeenCalled();
  });

  it("keeps asynchronously arriving folders closed beneath an expanded parent", async () => {
    const initial = SCOPE_FILES.slice(0, 2);
    const { update, onSelectPath } = mountScopedTree(initial, true);
    await userEvent.click(
      screen.getByRole("treeitem", { name: "src", expanded: false }),
    );
    const loaded: PrTreeFile[] = [
      ...initial,
      { path: "docs/guide.md", sourceOnly: true },
      { path: "src/new-folder/late.ts", sourceOnly: true },
      { path: "src/new-folder/deeper/late-child.ts", sourceOnly: true },
    ];

    update(loaded, true);

    expect(folderRow("src")).toBeInTheDocument();
    expect(
      screen.getByRole("treeitem", { name: "docs", expanded: false }),
    ).toBeInTheDocument();
    const arriving = screen.getByRole("treeitem", {
      name: "new-folder",
      expanded: false,
    });
    expect(screen.queryByText("late.ts")).not.toBeInTheDocument();
    await userEvent.click(arriving);
    expect(screen.getByText("late.ts")).toBeInTheDocument();
    expect(
      screen.getByRole("treeitem", { name: "deeper", expanded: false }),
    ).toBeInTheDocument();
    expect(screen.queryByText("late-child.ts")).not.toBeInTheDocument();
    expect(onSelectPath).not.toHaveBeenCalled();
  });

  it("focuses an offscreen collapsed folder before opening and selecting its child", async () => {
    const height = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(560);
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(288);
    try {
      const files = Array.from({ length: 3000 }, (_, index) => ({
        path: `folder-${String(index).padStart(4, "0")}/file.ts`,
        additions: 1,
        deletions: 0,
      }));
      const { onSelectPath } = mountScopedTree(files, true);
      const first = screen.getByRole("treeitem", {
        name: "folder-0000",
        expanded: false,
      });
      act(() => first.focus());

      await userEvent.keyboard("{End}");

      const last = screen.getByRole("treeitem", {
        name: "folder-2999",
        expanded: false,
      });
      expect(last).toHaveFocus();
      expect(onSelectPath).not.toHaveBeenCalled();
      await userEvent.keyboard("{ArrowRight}");
      expect(last).toHaveAttribute("aria-expanded", "true");
      expect(onSelectPath).not.toHaveBeenCalled();
      await userEvent.keyboard("{ArrowRight}");
      expect(
        screen.getByRole("treeitem", { name: /folder-2999.*file\.ts/ }),
      ).toHaveFocus();
      expect(onSelectPath).toHaveBeenLastCalledWith("folder-2999/file.ts");
      expect(screen.getAllByRole("treeitem").length).toBeLessThan(100);
    } finally {
      height.mockRestore();
      width.mockRestore();
    }
  });

  it("bounds mounted rows for a large tree and focuses an unmounted keyboard target", async () => {
    const height = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(560);
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(288);
    try {
      const files = Array.from({ length: 3000 }, (_, index) => ({
        path: `file-${String(index).padStart(4, "0")}.ts`,
        additions: 1,
        deletions: 0,
      }));
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
      const onSelectPath = vi.fn();
      render(
        <QueryClientProvider client={client}>
          <PrFilesTree
            files={files}
            effectivePath={files[0].path}
            onSelectPath={onSelectPath}
          />
        </QueryClientProvider>,
      );
      expect(screen.getAllByRole("treeitem").length).toBeLessThan(100);
      act(() => fileRow("file-0000.ts").focus());
      await userEvent.keyboard("{End}");
      expect(fileRow("file-2999.ts")).toHaveFocus();
      expect(onSelectPath).toHaveBeenLastCalledWith("file-2999.ts");
    } finally {
      height.mockRestore();
      width.mockRestore();
    }
  });

  it("groups changed files into directories and preserves full file names and stats", async () => {
    await mount();

    const tree = screen.getByRole("tree", { name: "Changed files" });
    const rows = within(tree).getAllByRole("treeitem");
    expect(rows.map((row) => row.getAttribute("data-path"))).toEqual([
      null,
      "assets/logo.bin",
      null,
      LONG_PATH,
      "src/features/z-last.ts",
      "README.md",
    ]);
    expect(folderRow("assets")).toHaveAttribute("aria-level", "1");
    expect(folderRow("src/features")).toHaveAttribute("aria-level", "1");
    expect(fileRow(LONG_NAME)).toHaveAttribute("aria-level", "2");
    expect(within(fileRow(LONG_NAME)).getByText(LONG_NAME)).toHaveTextContent(
      LONG_NAME,
    );
    expect(fileRow(LONG_NAME)).toHaveAttribute("aria-selected", "true");
    expect(fileRow("z-last.ts")).toHaveAccessibleName(
      /12 lines added, 4 lines deleted/,
    );
    expect(fileRow("logo.bin")).toHaveAccessibleName(/Binary file/);
  });

  it("collapses directories without changing the selected diff", async () => {
    await mount();
    const folder = folderRow("src/features");

    await userEvent.click(folder);

    expect(folder).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(LONG_NAME)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Selected file")).toHaveTextContent(LONG_PATH);
    expect(folder).toHaveFocus();

    await userEvent.click(folder);
    expect(fileRow(LONG_NAME)).toHaveAttribute("aria-selected", "true");
  });

  it("lands focus on a collapsed directory when its clicked button was not focused", async () => {
    await mount();
    act(() => fileRow(LONG_NAME).focus());
    const folder = folderRow("src/features");

    fireEvent.click(folder);

    expect(folder).toHaveFocus();
    expect(folder).toHaveAttribute("aria-expanded", "false");
    await userEvent.keyboard("{ArrowDown}");
    expect(fileRow("README.md")).toHaveFocus();
  });

  it("navigates visible tree rows and expands folders with the keyboard", async () => {
    await mount();
    const selected = fileRow(LONG_NAME);
    act(() => selected.focus());

    await userEvent.keyboard("{ArrowUp}");
    const folder = folderRow("src/features");
    expect(folder).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(folder).toHaveAttribute("aria-expanded", "false");
    await userEvent.keyboard("{ArrowDown}");
    expect(fileRow("README.md")).toHaveFocus();
    expect(screen.getByLabelText("Selected file")).toHaveTextContent(
      "README.md",
    );

    await userEvent.keyboard("{ArrowUp}{ArrowRight}{ArrowRight}");
    expect(fileRow(LONG_NAME)).toHaveFocus();
    expect(fileRow(LONG_NAME)).toHaveAttribute("aria-selected", "true");

    await userEvent.keyboard("{ArrowLeft}");
    expect(folderRow("src/features")).toHaveFocus();
    const chord = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    folderRow("src/features").dispatchEvent(chord);
    expect(chord.defaultPrevented).toBe(false);
    expect(folderRow("src/features")).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps file row context actions away from directories", async () => {
    await mount(true);

    fireEvent.contextMenu(folderRow("src/features"));
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();

    fireEvent.contextMenu(fileRow(LONG_NAME));
    expect(
      await screen.findByRole("menuitem", { name: "View file history…" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Blame…" }),
    ).toBeInTheDocument();
  });

  it("preserves directory collapse when the file sidebar closes and reopens", async () => {
    await mount();
    await userEvent.click(folderRow("src/features"));
    await userEvent.click(
      screen.getByRole("button", { name: "Collapse file list" }),
    );
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Expand file list" }),
    );
    expect(
      screen.getByRole("treeitem", { name: "src/features", expanded: false }),
    ).toBeInTheDocument();
    expect(screen.queryByText(LONG_NAME)).not.toBeInTheDocument();
  });
});
