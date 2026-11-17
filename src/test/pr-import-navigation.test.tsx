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
import { toast } from "sonner";
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
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { stubCanvas } from "./canvas-stub";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitObjectsPresent: vi.fn(),
}));
vi.mock("@/lib/git/api/pr-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api/pr-snapshot")>()),
  gitPrSnapshotFiles: vi.fn(),
  gitPrSnapshotFile: vi.fn(),
  gitPrSnapshotComparison: vi.fn(),
}));

const HEAD = "a".repeat(40);
const NEXT_HEAD = "b".repeat(40);
const ENTRY = "src/entry.ts";
const FILES = [
  { path: ENTRY, additions: 4, deletions: 0 },
  { path: "src/next.ts", additions: 1, deletions: 0 },
];
const listing = [
  ENTRY,
  "src/next.ts",
  "src/context.tsx",
  "src/other.ts",
  "src/lib/alias.ts",
  "tsconfig.json",
].map((path) => ({ path, undecodable: false }));
const IMPORTS = [
  'import next from "./next";',
  'import context from "./context";',
  'import other from "./other";',
  'import alias from "@lib/alias";',
].join("\n");
const snapshot = vi.mocked(gitPrSnapshotFiles);
const bytes = vi.mocked(gitPrSnapshotFile);
const comparison = vi.mocked(gitPrSnapshotComparison);
const clients: QueryClient[] = [];

// jsdom has no scrolling implementation; real tree bounds are browser-verified.
Element.prototype.scrollIntoView ??= () => undefined;

function fileBytes(text: string) {
  return { base64: btoa(text), mime: null, tooLarge: false, size: text.length };
}

beforeAll(() => {
  stubCanvas();
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(gitObjectsPresent).mockResolvedValue(false);
  snapshot.mockResolvedValue(listing);
  bytes.mockImplementation(async (_repo, _head, path) =>
    fileBytes(
      path === "tsconfig.json"
        ? '{ "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["src/lib/*"] } } }'
        : 'import next from "./next";\nexport const value = "MR head context";\n',
    ),
  );
  comparison.mockResolvedValue({
    baseSha: "c".repeat(40),
    headSha: HEAD,
    oldPath: ENTRY,
    newPath: ENTRY,
    before: fileBytes(`${IMPORTS}\n`),
    after: fileBytes(`${IMPORTS}\n`),
    patch: "",
  });
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
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockRestore();
  document
    .querySelectorAll("[data-test-import-composer]")
    .forEach((node) => node.remove());
});

type HarnessProps = { head?: string; enabled?: boolean; firstLine?: number };
function Harness({ head = HEAD, enabled = true, firstLine = 1 }: HarnessProps) {
  const [path, setPath] = useState<string | null>(ENTRY);
  const text =
    path === ENTRY ? IMPORTS : 'export const next = "changed target";';
  const lines = text.split("\n");
  return (
    <>
      <output aria-label="Selected MR change">{path}</output>
      <button type="button" onClick={() => setPath("src/next.ts")}>
        Pick next externally
      </button>
      <PrFilesPane
        files={FILES}
        effectivePath={path}
        onSelectPath={setPath}
        fileDiff={{
          filePath: path ?? ENTRY,
          text: `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +${firstLine},${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`,
          isBinary: false,
          isTruncated: false,
        }}
        isPending={false}
        isError={false}
        isFetching={false}
        repoPath="/repo"
        lens="origin"
        number={7}
        blameRev={head}
        provider="gitlab"
        interactionEnabled={enabled}
      />
    </>
  );
}

function mount(initial: HarnessProps = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
  const view = render(
    <QueryClientProvider client={client}>
      <Harness {...initial} />
    </QueryClientProvider>,
  );
  return {
    ...view,
    update: (props: HarnessProps) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <Harness {...initial} {...props} />
        </QueryClientProvider>,
      ),
  };
}

describe("MR import navigation", () => {
  it("opens a changed import and reveals it without eagerly loading the source tree", async () => {
    mount();
    const link = await screen.findByRole("link", { name: "./next" });
    expect(snapshot).not.toHaveBeenCalled();
    await userEvent.click(link);
    await waitFor(() =>
      expect(screen.getByLabelText("Selected MR change")).toHaveTextContent(
        "src/next.ts",
      ),
    );
    expect(screen.getByRole("treeitem", { name: /next.ts/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "File scope: MR changes" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(snapshot).toHaveBeenCalledWith("/repo", 7, HEAD, "origin");
  });

  it("opens an unchanged import at MR head and reveals only its ancestors in All files", async () => {
    mount();
    await userEvent.click(
      await screen.findByRole("link", { name: "./context" }),
    );
    const source = await screen.findByRole("region", {
      name: "Source of src/context.tsx",
    });
    await waitFor(() => expect(source).toHaveTextContent("MR head context"));
    expect(
      screen.getByRole("button", { name: "File scope: All files" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("treeitem", { name: /context.ts/ }),
    ).toHaveAttribute("aria-selected", "true");
    expect(bytes).toHaveBeenCalledWith(
      "/repo",
      HEAD,
      "src/context.tsx",
      "origin",
    );
    expect(screen.getByLabelText("Selected MR change")).toHaveTextContent(
      ENTRY,
    );
    await userEvent.click(await screen.findByRole("link", { name: "./next" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Selected MR change")).toHaveTextContent(
        "src/next.ts",
      ),
    );
  });

  it("prepares an unfetched head before proving an import in a partial hunk", async () => {
    let headPresent = false;
    snapshot.mockImplementation(async () => {
      headPresent = true;
      return listing;
    });
    bytes.mockImplementation(async (_repo, _head, path) => {
      if (!headPresent) throw new Error("Head commit is unavailable");
      return fileBytes(
        path === ENTRY
          ? `${Array.from({ length: 7 }, () => "// Earlier source context").join("\n")}\n${IMPORTS}\n`
          : 'export const context = "proven MR head";\n',
      );
    });
    mount({ firstLine: 8 });
    await userEvent.click(
      await screen.findByRole("link", { name: "./context" }),
    );
    await screen.findByRole("region", { name: "Source of src/context.tsx" });
    expect(snapshot).toHaveBeenCalledOnce();
    expect(bytes).toHaveBeenCalledWith("/repo", HEAD, ENTRY, "origin");
  });

  it("uses aliases declared in this MR's config snapshot", async () => {
    mount();
    await userEvent.click(
      await screen.findByRole("link", { name: "@lib/alias" }),
    );
    await screen.findByRole("region", { name: "Source of src/lib/alias.ts" });
    expect(bytes).toHaveBeenCalledWith(
      "/repo",
      HEAD,
      "tsconfig.json",
      "origin",
    );
    expect(bytes).toHaveBeenCalledWith(
      "/repo",
      HEAD,
      "src/lib/alias.ts",
      "origin",
    );
  });

  it("supports the same links in complete before/after views", async () => {
    mount();
    await screen.findByRole("link", { name: "./context" });
    await userEvent.click(screen.getByRole("button", { name: "Full file" }));
    const link = await screen.findByRole("link", { name: "./context" });
    await userEvent.click(link);
    await screen.findByRole("region", { name: "Source of src/context.tsx" });
    expect(comparison).toHaveBeenCalledWith("/repo", 7, HEAD, ENTRY, "origin");
  });

  it("follows an import from the large plain-source editor using its native decorations", async () => {
    bytes.mockImplementation(async () =>
      fileBytes(
        `const heading = <p>import example from "./ordinary-text";</p>;\nimport next from "./next";\n${"// Large read-only source context\n".repeat(2_100)}`,
      ),
    );
    mount();
    await userEvent.click(
      await screen.findByRole("link", { name: "./context" }),
    );
    const source = await screen.findByRole("region", {
      name: "Source of src/context.tsx",
    });
    const link = await within(source).findByRole("link", { name: "./next" });
    expect(link.closest(".cm-editor")).not.toBeNull();
    expect(
      within(source).queryByRole("link", { name: "./ordinary-text" }),
    ).toBeNull();
    expect(source).toHaveTextContent('import example from "./ordinary-text";');
    link.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByLabelText("Selected MR change")).toHaveTextContent(
        "src/next.ts",
      ),
    );
  });

  it("discards a resolution when a different file is selected while it loads", async () => {
    let finish!: (value: typeof listing) => void;
    snapshot.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    mount();
    await userEvent.click(
      await screen.findByRole("link", { name: "./context" }),
    );
    await waitFor(() => expect(snapshot).toHaveBeenCalledOnce());
    await userEvent.click(
      screen.getByRole("button", { name: "Pick next externally" }),
    );
    await act(async () => finish(listing));
    expect(screen.getByLabelText("Selected MR change")).toHaveTextContent(
      "src/next.ts",
    );
    expect(
      screen.queryByRole("region", { name: "Source of src/context.tsx" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "File scope: MR changes" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("discards a resolution when the request head changes", async () => {
    let finish!: (value: typeof listing) => void;
    snapshot.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = mount();
    await userEvent.click(
      await screen.findByRole("link", { name: "./context" }),
    );
    await waitFor(() => expect(snapshot).toHaveBeenCalledOnce());
    view.update({ head: NEXT_HEAD });
    await act(async () => finish(listing));
    expect(
      screen.queryByRole("region", { name: "Source of src/context.tsx" }),
    ).toBeNull();
    expect(bytes).not.toHaveBeenCalled();
  });

  it("blocks import activation while an unsaved line composer is open", async () => {
    mount();
    const link = await screen.findByRole("link", { name: "./context" });
    const editor = document.createElement("div");
    editor.dataset.diffLineWidget = "layout";
    editor.dataset.testImportComposer = "";
    document.body.append(editor);
    fireEvent.click(link);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("retires a pending import after another navigation even when the same file remains shown", async () => {
    let finish!: (value: typeof listing) => void;
    snapshot.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    mount();
    await userEvent.click(
      await screen.findByRole("link", { name: "./context" }),
    );
    await waitFor(() => expect(snapshot).toHaveBeenCalledOnce());
    useUiStore.getState().noteUserInteraction();
    await act(async () => finish(listing));
    expect(
      screen.queryByRole("region", { name: "Source of src/context.tsx" }),
    ).toBeNull();
    expect(screen.getByLabelText("Selected MR change")).toHaveTextContent(
      ENTRY,
    );
  });

  it("retires a pending import when the request becomes inactive and active again", async () => {
    let finish!: (value: typeof listing) => void;
    snapshot.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = mount();
    await userEvent.click(
      await screen.findByRole("link", { name: "./context" }),
    );
    await waitFor(() => expect(snapshot).toHaveBeenCalledOnce());
    view.update({ enabled: false });
    view.update({ enabled: true });
    await act(async () => finish(listing));
    expect(
      screen.queryByRole("region", { name: "Source of src/context.tsx" }),
    ).toBeNull();
  });

  it("lands only the most recent import activation while sharing the snapshot read", async () => {
    let finish!: (value: typeof listing) => void;
    snapshot.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    mount();
    await userEvent.click(
      await screen.findByRole("link", { name: "./context" }),
    );
    await userEvent.click(screen.getByRole("link", { name: "./other" }));
    await act(async () => finish(listing));
    await screen.findByRole("region", { name: "Source of src/other.ts" });
    expect(snapshot).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("region", { name: "Source of src/context.tsx" }),
    ).toBeNull();
    expect(bytes).not.toHaveBeenCalledWith(
      "/repo",
      HEAD,
      "src/context.tsx",
      "origin",
    );
  });

  it("keeps the current view and explains an unresolved import", async () => {
    snapshot.mockResolvedValueOnce([{ path: ENTRY, undecodable: false }]);
    const info = vi.spyOn(toast, "info");
    mount();
    await userEvent.click(
      await screen.findByRole("link", { name: "./context" }),
    );
    await waitFor(() => expect(info).toHaveBeenCalled());
    expect(screen.getByLabelText("Selected MR change")).toHaveTextContent(
      ENTRY,
    );
    expect(
      screen.getByRole("button", { name: "File scope: MR changes" }),
    ).toHaveAttribute("aria-pressed", "false");
    info.mockRestore();
  });
});
