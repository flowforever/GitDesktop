import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrFilesPane } from "@/features/pulls/RemotePrViewParts";
import { usePrFileHistory } from "@/features/pulls/usePrFileHistory";
import { gitObjectsPresent } from "@/lib/git/api";
import {
  gitPrSnapshotFile,
  gitPrSnapshotFiles,
} from "@/lib/git/api/pr-snapshot";
import {
  prSnapshotFileOptions,
  prSnapshotFilesOptions,
} from "@/lib/git/queries/pr-snapshot";
import { dispatchAction } from "@/lib/hotkeys/handler-registry";
import { ACTIONS, resolveDefaultBinding } from "@/lib/hotkeys/registry";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";

vi.mock("@/features/diff/DiffSurfaceLazy", async () => {
  const { useReportPaneSettled } = await import(
    "@/features/diff/diff-pane-hold"
  );
  return {
    DiffContent: ({
      filePath,
      data,
    }: {
      filePath: string;
      data?: { text: string };
    }) => {
      useReportPaneSettled(true);
      const text = (data?.text ?? "")
        .split("\n")
        .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
        .map((line) => line.slice(1))
        .join("\n");
      return (
        <div role="group" aria-label={`Diff of ${filePath}`}>
          <pre
            className="gd-code"
            dangerouslySetInnerHTML={{
              __html: text
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;"),
            }}
          />
        </div>
      );
    },
  };
});
vi.mock("@/lib/git/api", async (original) => ({
  ...(await original<typeof import("@/lib/git/api")>()),
  gitObjectsPresent: vi.fn(),
}));
vi.mock("@/lib/git/api/pr-snapshot", async (original) => ({
  ...(await original<typeof import("@/lib/git/api/pr-snapshot")>()),
  gitPrSnapshotFiles: vi.fn(),
  gitPrSnapshotFile: vi.fn(),
}));

const HEAD = "a".repeat(40);
const A = "src/a.ts";
const B = "src/b.ts";
const C = "src/c.ts";
const D = "src/d.ts";
const SOURCE = "src/context.ts";
const FILES = [A, B, C, D].map((path) => ({
  path,
  additions: 1,
  deletions: 0,
}));
const clients: QueryClient[] = [];
const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollIntoView",
);

type HarnessProps = {
  repo?: string;
  head?: string;
  lens?: "origin" | "upstream";
  number?: number;
  enabled?: boolean;
};

/** Like RemotePrView, the owner outlives its conditional Files section. */
function Harness({
  repo = "/repo",
  head = HEAD,
  lens = "origin",
  number = 7,
  enabled = true,
}: HarnessProps) {
  const [path, setPath] = useState<string | null>(A);
  const [filesOpen, setFilesOpen] = useState(true);
  const history = usePrFileHistory(
    JSON.stringify([repo, lens, number, head]),
    path,
    enabled,
  );
  const text =
    path === A
      ? 'import context from "./context";'
      : `export const changed = "${path}";`;
  return (
    <>
      <output aria-label="Selected changed file">{path}</output>
      <button type="button" onClick={() => setFilesOpen(!filesOpen)}>
        {filesOpen ? "Show conversation" : "Show files"}
      </button>
      {filesOpen && (
        <PrFilesPane
          files={FILES}
          effectivePath={path}
          onSelectPath={setPath}
          fileHistory={history}
          fileDiff={{
            filePath: path ?? A,
            text: `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${text}\n`,
            isBinary: false,
            isTruncated: false,
          }}
          isPending={false}
          isError={false}
          isFetching={false}
          repoPath={repo}
          lens={lens}
          number={number}
          blameRev={head}
          provider="gitlab"
          interactionEnabled={enabled}
        />
      )}
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
    client,
    update: (next: HarnessProps) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <Harness {...initial} {...next} />
        </QueryClientProvider>,
      ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  vi.mocked(gitObjectsPresent).mockResolvedValue(false);
  vi.mocked(gitPrSnapshotFiles).mockResolvedValue(
    [...FILES, { path: SOURCE }, { path: "unrelated/deep/keep.ts" }].map(
      ({ path }) => ({ path, undecodable: false }),
    ),
  );
  vi.mocked(gitPrSnapshotFile).mockResolvedValue({
    base64: btoa('import next from "./c";'),
    mime: null,
    tooLarge: false,
    size: 23,
  });
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  document
    .querySelectorAll("[data-test-history-composer]")
    .forEach((node) => node.remove());
  if (originalScrollIntoView)
    Object.defineProperty(
      Element.prototype,
      "scrollIntoView",
      originalScrollIntoView,
    );
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

const back = () => screen.getByRole("button", { name: "Back in file history" });
const forward = () =>
  screen.getByRole("button", { name: "Forward in file history" });
const selected = () =>
  screen.getByLabelText("Selected changed file").textContent;

async function openFileList() {
  const expand = screen.queryByRole("button", { name: "Expand file list" });
  if (expand) await userEvent.click(expand);
}
async function pick(path: string) {
  await userEvent.click(
    await screen.findByRole("treeitem", {
      name: new RegExp(path.split("/").at(-1)!.replace(".", "\\.")),
    }),
  );
}

describe("MR visited-file history", () => {
  it("walks A → B → C backward and forward without adding history entries", async () => {
    mount();
    await openFileList();
    expect(back()).toHaveAttribute("aria-disabled", "true");
    expect(back()).toHaveAccessibleDescription(/earlier|previous|history/i);
    expect(forward()).toHaveAttribute("aria-disabled", "true");
    await pick(B);
    await pick(C);

    await userEvent.click(back());
    expect(selected()).toBe(B);
    await userEvent.click(back());
    expect(selected()).toBe(A);
    expect(back()).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(forward());
    expect(selected()).toBe(B);
    await userEvent.click(forward());
    expect(selected()).toBe(C);
    expect(forward()).toHaveAttribute("aria-disabled", "true");
  });

  it("drops the forward branch after a new file and coalesces repeated picks", async () => {
    mount();
    await openFileList();
    await pick(B);
    await pick(C);
    await userEvent.click(back());
    await pick(D);
    await pick(D);

    expect(forward()).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(back());
    expect(selected()).toBe(B);
    await userEvent.click(back());
    expect(selected()).toBe(A);
  });

  it("updates scope on the current file without creating duplicate file steps", async () => {
    mount();
    await openFileList();
    await userEvent.click(
      screen.getByRole("button", { name: "File scope: MR changes" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "File scope: All files" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Next changed file" }),
    );
    expect(selected()).toBe(B);

    await userEvent.click(back());

    expect(selected()).toBe(A);
    expect(back()).toHaveAttribute("aria-disabled", "true");
  });

  it("restores import source scope and reveals only its parents across back and forward", async () => {
    mount();
    await openFileList();
    await userEvent.click(
      await screen.findByRole("link", { name: "./context" }),
    );
    await screen.findByRole("region", { name: `Source of ${SOURCE}` });
    expect(
      screen.getByRole("button", { name: "File scope: All files" }),
    ).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(back());
    await screen.findByRole("group", { name: `Diff of ${A}` });
    expect(
      screen.getByRole("button", { name: "File scope: MR changes" }),
    ).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(forward());
    await screen.findByRole("region", { name: `Source of ${SOURCE}` });
    expect(
      screen.getByRole("treeitem", { name: /context\.ts.*Unchanged/ }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("treeitem", { name: "unrelated/deep" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("treeitem", { name: /keep\.ts/ })).toBeNull();
    expect(
      vi
        .mocked(gitPrSnapshotFile)
        .mock.calls.every((call) => call[2] === SOURCE),
    ).toBe(true);

    await userEvent.click(await screen.findByRole("link", { name: "./c" }));
    await waitFor(() => expect(selected()).toBe(C));
    await userEvent.click(back());
    await screen.findByRole("region", { name: `Source of ${SOURCE}` });
  });

  it("keeps source selection, scope and history when the Files section remounts", async () => {
    mount();
    await openFileList();
    await userEvent.click(
      await screen.findByRole("link", { name: "./context" }),
    );
    await screen.findByRole("region", { name: `Source of ${SOURCE}` });
    await userEvent.click(
      screen.getByRole("button", { name: "Show conversation" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Show files" }));
    // A remounted narrow rail starts collapsed independently of file scope.
    await openFileList();

    await screen.findByRole("region", { name: `Source of ${SOURCE}` });
    expect(
      screen.getByRole("button", { name: "File scope: All files" }),
    ).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(back());
    expect(selected()).toBe(A);
    await userEvent.click(forward());
    await screen.findByRole("region", { name: `Source of ${SOURCE}` });
  });

  it("prepares only the restored source when its file-list cache is cold", async () => {
    const view = mount();
    await openFileList();
    await userEvent.click(
      await screen.findByRole("link", { name: "./context" }),
    );
    await screen.findByRole("region", { name: `Source of ${SOURCE}` });
    await userEvent.click(
      screen.getByRole("button", { name: "Show conversation" }),
    );
    view.client.removeQueries({
      queryKey: prSnapshotFilesOptions("/repo", 7, HEAD, "origin").queryKey,
    });
    view.client.removeQueries({
      queryKey: prSnapshotFileOptions("/repo", HEAD, SOURCE).queryKey,
    });
    vi.mocked(gitPrSnapshotFile).mockClear();
    let resolveHead!: (
      paths: Awaited<ReturnType<typeof gitPrSnapshotFiles>>,
    ) => void;
    vi.mocked(gitPrSnapshotFiles).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHead = resolve;
        }),
    );

    await userEvent.click(screen.getByRole("button", { name: "Show files" }));
    await openFileList();
    await waitFor(() =>
      expect(vi.mocked(gitPrSnapshotFiles)).toHaveBeenCalledTimes(2),
    );
    expect(screen.queryByRole("group", { name: `Diff of ${A}` })).toBeNull();
    expect(vi.mocked(gitPrSnapshotFile)).not.toHaveBeenCalled();
    await act(async () =>
      resolveHead(
        [...FILES, { path: SOURCE }, { path: "unrelated/deep/keep.ts" }].map(
          ({ path }) => ({ path, undecodable: false }),
        ),
      ),
    );

    await screen.findByRole("region", { name: `Source of ${SOURCE}` });
    expect(
      screen.getByRole("treeitem", { name: /context\.ts.*Unchanged/ }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("treeitem", { name: "unrelated/deep" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(vi.mocked(gitPrSnapshotFile)).toHaveBeenCalledExactlyOnceWith(
      "/repo",
      HEAD,
      SOURCE,
      "origin",
    );
  });

  it.each([
    { repo: "/other" },
    { lens: "upstream" as const },
    { number: 8 },
    { head: "b".repeat(40) },
  ])("resets history when request identity changes: %j", async (next) => {
    const view = mount();
    await openFileList();
    await pick(B);
    expect(back()).not.toHaveAttribute("aria-disabled", "true");

    view.update(next);
    await openFileList();

    expect(back()).toHaveAttribute("aria-disabled", "true");
    expect(forward()).toHaveAttribute("aria-disabled", "true");
  });

  it("supports button Enter and palette history actions without default shortcuts", async () => {
    mount();
    await openFileList();
    await pick(B);
    back().focus();
    await userEvent.keyboard("{Enter}");
    expect(selected()).toBe(A);
    act(() => dispatchAction("pr-file-forward"));
    expect(selected()).toBe(B);
    act(() => dispatchAction("pr-file-back"));
    expect(selected()).toBe(A);
    for (const id of ["pr-file-back", "pr-file-forward"] as const) {
      const action = ACTIONS.find((entry) => entry.id === id);
      if (!action) throw new Error(`Missing action ${id}`);
      expect(resolveDefaultBinding(action, false)).toBeNull();
      expect(resolveDefaultBinding(action, true)).toBeNull();
    }
  });

  it("checks a newly opened comment editor before consuming history", async () => {
    mount();
    await openFileList();
    await pick(B);
    const previous = back();
    const editor = document.createElement("div");
    editor.dataset.diffLineWidget = "layout";
    editor.dataset.testHistoryComposer = "true";
    document.body.append(editor);
    fireEvent.click(previous);
    act(() => dispatchAction("pr-file-back"));

    expect(selected()).toBe(B);
    editor.remove();
    await waitFor(() =>
      expect(back()).not.toHaveAttribute("aria-disabled", "true"),
    );
    await userEvent.click(back());
    expect(selected()).toBe(A);
  });
});
