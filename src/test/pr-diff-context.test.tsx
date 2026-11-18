import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
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
import { gitFileBase64, gitObjectsPresent } from "@/lib/git/api";
import {
  gitPrSnapshotComparison,
  gitPrSnapshotFile,
  gitPrSnapshotFiles,
  type PrSnapshotComparison,
} from "@/lib/git/api/pr-snapshot";
import type { FileDiff } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { stubCanvas } from "./canvas-stub";

// Keep the actual DiffSurface and native diff renderer: these are the same gap
// controls Local Changes gets from complete old/new file models.
vi.mock("@/lib/git/api", async (original) => ({
  ...(await original<typeof import("@/lib/git/api")>()),
  gitFileBase64: vi.fn(),
  gitObjectsPresent: vi.fn(),
  forgeStatus: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("@/lib/git/api/pr-snapshot", async (original) => ({
  ...(await original<typeof import("@/lib/git/api/pr-snapshot")>()),
  gitPrSnapshotFiles: vi.fn(),
  gitPrSnapshotFile: vi.fn(),
  gitPrSnapshotComparison: vi.fn(),
}));
vi.mock("@/lib/settings/api", async (original) => ({
  ...(await original<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

const REPO = "/request-checkout";
const HEAD = "abcdef0123".repeat(4);
const BASE = "fedcba9876".repeat(4);
const NEXT_HEAD = "123456789a".repeat(4);
const PATH = "src/request.txt";
const OTHER = "src/other.txt";
const comparison = vi.mocked(gitPrSnapshotComparison);
const clients: QueryClient[] = [];
const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollIntoView",
);

function bytes(text: string) {
  return { base64: btoa(text), mime: null, tooLarge: false, size: text.length };
}

function fixture(
  path = PATH,
  oldPath = path,
  tag = "MR",
  bareBlankEol?: "\n" | "\r\n",
) {
  const before = Array.from(
    { length: 70 },
    (_, index) => `${tag} context ${String(index + 1).padStart(2, "0")}`,
  );
  const after = [...before];
  before[19] = `${tag} old first`;
  after[19] = `${tag} new first`;
  before[49] = `${tag} old second`;
  after[49] = `${tag} new second`;
  if (bareBlankEol)
    for (const index of [18, 20, 48, 50]) before[index] = after[index] = "";
  const carriage = bareBlankEol === "\r\n" ? "\r" : "";
  const header = `diff --git a/${oldPath} b/${path}\n--- a/${oldPath}\n+++ b/${path}\n`;
  const rows = (from: number, to: number, bare = false) =>
    before
      .slice(from, to)
      .flatMap((line, offset) =>
        line === after[from + offset]
          ? [`${bare && line === "" ? "" : " "}${line}${carriage}`]
          : [`-${line}${carriage}`, `+${after[from + offset]}${carriage}`],
      );
  const diff: FileDiff = {
    filePath: path,
    text: `${header}@@ -19,3 +19,3 @@\n${rows(18, 21, !!bareBlankEol).join("\n")}\n@@ -49,3 +49,3 @@\n${rows(48, 51, !!bareBlankEol).join("\n")}\n`,
    isBinary: false,
    isTruncated: false,
    ...(oldPath === path ? {} : { oldPath }),
  };
  const pair: PrSnapshotComparison = {
    baseSha: BASE,
    headSha: HEAD,
    oldPath,
    newPath: path,
    before: bytes(
      `${before.join(bareBlankEol ?? "\n")}${bareBlankEol ?? "\n"}`,
    ),
    after: bytes(`${after.join(bareBlankEol ?? "\n")}${bareBlankEol ?? "\n"}`),
    patch: `${header}@@ -1,70 +1,70 @@\n${rows(0, 70).join("\n")}\n`,
  };
  return { diff, pair };
}

type Props = ComponentProps<typeof PrFilesPane>;

function mount(
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
    files: [
      { path: PATH, additions: 2, deletions: 2 },
      { path: OTHER, additions: 2, deletions: 2 },
    ],
    effectivePath: PATH,
    onSelectPath: vi.fn(),
    fileDiff: fixture().diff,
    isPending: false,
    isError: false,
    isFetching: false,
    repoPath: REPO,
    lens: "origin",
    number: 17,
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
    update(next: Partial<Props>) {
      props = { ...props, ...next };
      view.rerender(<PrFilesPane {...props} />);
    },
  };
}

beforeAll(stubCanvas);
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  onlineManager.setOnline(true);
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(gitObjectsPresent).mockResolvedValue(false);
  vi.mocked(gitFileBase64).mockRejectedValue(
    new Error("Never substitute the checkout"),
  );
  vi.mocked(gitPrSnapshotFile).mockRejectedValue(
    new Error("Use the authoritative pair"),
  );
  vi.mocked(gitPrSnapshotFiles).mockResolvedValue([
    { path: PATH, undecodable: false },
    { path: OTHER, undecodable: false },
  ]);
  comparison.mockReset().mockResolvedValue(fixture().pair);
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  onlineManager.setOnline(true);
  if (originalScrollIntoView)
    Object.defineProperty(
      Element.prototype,
      "scrollIntoView",
      originalScrollIntoView,
    );
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

describe("MR Diff context expansion", () => {
  it.each([
    { label: "LF", eol: "\n" as const, mode: "unified" as const },
    { label: "CRLF", eol: "\r\n" as const, mode: "split" as const },
  ])(
    "expands a GitLab partial patch with bare empty $label context rows",
    async ({ eol, mode }) => {
      const data = fixture(PATH, PATH, "GitLab", eol);
      comparison.mockResolvedValue(data.pair);
      mount({ fileDiff: data.diff }, mode);
      const group = await screen.findByRole("group", {
        name: `Diff of ${PATH}`,
      });
      const leading = await within(group).findAllByRole("button", {
        name: "Expand Up",
      });

      expect(group).toHaveTextContent("GitLab old first");
      expect(group).toHaveTextContent("GitLab new second");
      expect(group).not.toHaveTextContent("GitLab context 01");
      expect(group).not.toHaveTextContent("GitLab context 22");
      expect(group).not.toHaveTextContent("GitLab context 70");
      await userEvent.click(leading[0]);
      expect(group).toHaveTextContent("GitLab context 01");
      expect(group).not.toHaveTextContent("GitLab context 22");
      await userEvent.click(
        within(group).getAllByRole("button", { name: "Expand All" })[0],
      );
      expect(group).toHaveTextContent("GitLab context 22");
      expect(group).not.toHaveTextContent("GitLab context 70");
      await userEvent.click(
        within(group).getAllByRole("button", { name: "Expand Down" }).at(-1)!,
      );
      expect(group).toHaveTextContent("GitLab context 70");
      expect(comparison).toHaveBeenCalledExactlyOnceWith(
        REPO,
        17,
        HEAD,
        PATH,
        "origin",
      );
      expect(vi.mocked(gitFileBase64)).not.toHaveBeenCalled();
    },
  );

  it.each(["unified", "split"] as const)(
    "keeps omitted code collapsed and expands leading, middle and trailing gaps in %s",
    async (mode) => {
      const user = userEvent.setup();
      mount({}, mode);
      const group = await screen.findByRole("group", {
        name: `Diff of ${PATH}`,
      });
      await within(group).findAllByRole("button", { name: "Expand Up" });

      expect(screen.getByRole("button", { name: "Diff" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.getByRole("button", { name: "Full file" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(group).toHaveTextContent("MR old first");
      expect(group).toHaveTextContent("MR new second");
      expect(group).not.toHaveTextContent("MR context 01");
      expect(group).not.toHaveTextContent("MR context 22");
      expect(group).not.toHaveTextContent("MR context 70");

      await user.click(
        within(group).getAllByRole("button", { name: "Expand Up" })[0],
      );
      expect(group).toHaveTextContent("MR context 01");
      expect(group).toHaveTextContent("MR context 18");
      expect(group).not.toHaveTextContent("MR context 22");
      expect(group).not.toHaveTextContent("MR context 70");

      // The native renderer uses Expand All for this 27-line middle gap,
      // which is shorter than its 40-line expansion step.
      await user.click(
        within(group).getAllByRole("button", { name: "Expand All" })[0],
      );
      expect(group).toHaveTextContent("MR context 22");
      expect(group).not.toHaveTextContent("MR context 70");

      const trailing = within(group)
        .getAllByRole("button", { name: "Expand Down" })
        .at(-1);
      expect(trailing).toBeDefined();
      await user.click(trailing!);
      expect(group).toHaveTextContent("MR context 52");
      expect(group).toHaveTextContent("MR context 70");

      expect(comparison).toHaveBeenCalledTimes(1);
      expect(comparison).toHaveBeenCalledWith(REPO, 17, HEAD, PATH, "origin");
      expect(vi.mocked(gitFileBase64)).not.toHaveBeenCalled();
      expect(vi.mocked(gitPrSnapshotFile)).not.toHaveBeenCalled();
    },
  );

  it("uses the authoritative old path for a renamed file", async () => {
    const renamed = fixture(PATH, "before/request.txt", "renamed MR");
    comparison.mockResolvedValue(renamed.pair);
    mount({ fileDiff: renamed.diff });
    const group = await screen.findByRole("group", { name: `Diff of ${PATH}` });
    const leading = await within(group).findAllByRole("button", {
      name: "Expand Up",
    });

    await userEvent.click(leading[0]);

    expect(group).toHaveTextContent("renamed MR context 18");
    expect(comparison).toHaveBeenCalledWith(REPO, 17, HEAD, PATH, "origin");
    expect(vi.mocked(gitFileBase64)).not.toHaveBeenCalled();
  });

  it("retains the partial patch when the paired versions cannot be read", async () => {
    comparison.mockRejectedValue(new Error("Snapshot is unavailable"));
    mount();
    const group = await screen.findByRole("group", { name: `Diff of ${PATH}` });
    await waitFor(() => expect(comparison).toHaveBeenCalledTimes(1));

    expect(group).toHaveTextContent("MR old first");
    expect(group).toHaveTextContent("MR new second");
    expect(group).not.toHaveTextContent("MR context 18");
    expect(
      within(group).queryByRole("button", { name: "Expand Up" }),
    ).toBeNull();
    expect(vi.mocked(gitFileBase64)).not.toHaveBeenCalled();
  });

  it("refuses context from another head instead of pairing it with the shown patch", async () => {
    comparison.mockResolvedValue({ ...fixture().pair, headSha: NEXT_HEAD });
    mount();
    const group = await screen.findByRole("group", { name: `Diff of ${PATH}` });
    await waitFor(() => expect(comparison).toHaveBeenCalledTimes(1));

    expect(group).toHaveTextContent("MR new first");
    expect(group).not.toHaveTextContent("MR context 18");
    expect(
      within(group).queryByRole("button", { name: "Expand Up" }),
    ).toBeNull();
  });

  it("does not turn a silently omitted changed hunk into unchanged context", async () => {
    const original = fixture().diff;
    mount({
      fileDiff: {
        ...original,
        text: original.text.slice(0, original.text.indexOf("@@ -49")),
      },
    });
    const group = await screen.findByRole("group", { name: `Diff of ${PATH}` });
    await waitFor(() => expect(comparison).toHaveBeenCalledTimes(1));

    expect(group).toHaveTextContent("MR new first");
    expect(group).not.toHaveTextContent("MR context 22");
    expect(
      within(group).queryByRole("button", { name: "Expand Up" }),
    ).toBeNull();
  });

  it("keeps a real pending-comment edit mounted when context arrives", async () => {
    let resolvePair!: (pair: PrSnapshotComparison) => void;
    comparison.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePair = resolve;
        }),
    );
    mount({
      drafts: [
        {
          id: "context-draft",
          path: PATH,
          line: 20,
          side: "new",
          body: "Saved comment",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("textbox", {
      name: "Edit pending comment",
    });
    await user.clear(editor);
    await user.type(editor, "Unsaved review comment");

    await act(async () => resolvePair(fixture().pair));

    expect(screen.getByRole("textbox", { name: "Edit pending comment" })).toBe(
      editor,
    );
    expect(editor).toHaveValue("Unsaved review comment");
    expect(screen.queryByRole("button", { name: "Expand Up" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findAllByRole("button", { name: "Expand Up" });
  });

  it("does not attach an old selection's late context to the next selected file", async () => {
    let resolveFirst!: (pair: PrSnapshotComparison) => void;
    const first = new Promise<PrSnapshotComparison>((resolve) => {
      resolveFirst = resolve;
    });
    const other = fixture(OTHER, OTHER, "NEXT");
    comparison.mockImplementation((_repo, _number, _head, path) =>
      path === PATH ? first : Promise.resolve(other.pair),
    );
    const view = mount();
    await waitFor(() =>
      expect(comparison).toHaveBeenCalledWith(REPO, 17, HEAD, PATH, "origin"),
    );

    view.update({ effectivePath: OTHER, fileDiff: other.diff });
    await act(async () => resolveFirst(fixture().pair));
    const group = await screen.findByRole("group", {
      name: `Diff of ${OTHER}`,
    });
    const leading = await within(group).findAllByRole("button", {
      name: "Expand Up",
    });
    await userEvent.click(leading[0]);

    expect(group).toHaveTextContent("NEXT context 18");
    expect(group).not.toHaveTextContent("MR context 18");
    expect(group).not.toHaveTextContent("MR old first");
    expect(comparison).toHaveBeenCalledTimes(2);
  });
});
