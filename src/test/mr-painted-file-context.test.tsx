import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrFullFileDiff } from "@/features/pulls/PrFullFileDiff";
import { PrSourceFile } from "@/features/pulls/PrSourceFile";
import { PrFilesPane } from "@/features/pulls/RemotePrViewParts";
import { gitObjectsPresent } from "@/lib/git/api";
import {
  gitPrSnapshotComparison,
  gitPrSnapshotFile,
} from "@/lib/git/api/pr-snapshot";
import {
  prSnapshotComparisonOptions,
  prSnapshotFileOptions,
} from "@/lib/git/queries/pr-snapshot";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { stubCanvas } from "./canvas-stub";

vi.mock("@/lib/git/api", async (original) => ({
  ...(await original<typeof import("@/lib/git/api")>()),
  gitObjectsPresent: vi.fn(),
}));
vi.mock("@/lib/git/api/pr-snapshot", async (original) => ({
  ...(await original<typeof import("@/lib/git/api/pr-snapshot")>()),
  gitPrSnapshotFile: vi.fn(),
  gitPrSnapshotComparison: vi.fn(),
}));
// Blob-size decoration is unrelated to the provenance of its binary view.
vi.mock("@/features/diff/BinaryFileSummary", () => ({
  BinaryFileSummary: () => null,
}));

const REPO = "/repos/project";
const PATH = "assets/review.bin";
const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);
const NEXT_HEAD = "c".repeat(40);
const clients: QueryClient[] = [];
const bytes = (text: string, mime: string | null = null) => ({
  base64: btoa(text),
  mime,
  tooLarge: false,
  size: text.length,
});

beforeEach(() => {
  vi.clearAllMocks();
  stubCanvas();
  vi.mocked(gitObjectsPresent).mockResolvedValue(false);
  vi.mocked(gitPrSnapshotFile).mockImplementation(
    () => new Promise(() => undefined),
  );
  vi.mocked(gitPrSnapshotComparison).mockImplementation(
    () => new Promise(() => undefined),
  );
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

function marker(host: HTMLElement) {
  const element = host.querySelector<HTMLElement>("[data-diff-file-path]");
  expect(
    element,
    "The opened file should retain metadata even when no code rows render",
  ).not.toBeNull();
  if (!element) throw new Error("Missing painted file marker");
  return element;
}

describe("non-code MR source provenance", () => {
  it.each([
    { name: "empty", value: bytes(""), message: "Empty file", absent: false },
    {
      name: "binary",
      value: bytes("\0binary"),
      message: "Binary file — source preview unavailable.",
      absent: false,
    },
    {
      name: "image",
      value: bytes("image data", "image/png"),
      message: null,
      absent: false,
    },
    {
      name: "absent",
      value: null,
      message: "File not present at this MR head.",
      absent: true,
    },
  ])(
    "keeps the exact after revision on a $name source view",
    async ({ value, message, absent }) => {
      const view = setup();
      view.client.setQueryData(
        prSnapshotFileOptions(REPO, HEAD, PATH, "origin").queryKey,
        value,
      );
      render(
        <PrSourceFile
          repoPath={REPO}
          headSha={HEAD}
          path={PATH}
          reportRead={() => undefined}
        />,
        { wrapper: view.wrapper },
      );
      const source = await screen.findByRole("region", {
        name: `Source of ${PATH}`,
      });
      if (message) expect(source).toHaveTextContent(message);
      else
        expect(
          screen.getByRole("img", { name: `${PATH} at MR head` }),
        ).toBeInTheDocument();
      const painted = marker(source);
      expect(painted).toHaveAttribute("data-diff-file-path", PATH);
      expect(painted).toHaveAttribute("data-diff-head-sha", HEAD);
      expect(painted).toHaveAttribute(
        "data-diff-after-path",
        absent ? "" : PATH,
      );
      expect(painted).toHaveAttribute("data-diff-after-revision", HEAD);
      expect(painted).not.toHaveAttribute("data-diff-context-pending", "true");
      expect(painted).not.toHaveAttribute("data-diff-before-revision");
    },
  );

  it("marks a new source head as pending without relabelling the old ready content", async () => {
    const view = setup();
    view.client.setQueryData(
      prSnapshotFileOptions(REPO, HEAD, PATH, "origin").queryKey,
      bytes("old binary\0"),
    );
    let finish!: (value: ReturnType<typeof bytes>) => void;
    vi.mocked(gitPrSnapshotFile).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const tree = (headSha: string) => (
      <PrSourceFile
        repoPath={REPO}
        headSha={headSha}
        path={PATH}
        reportRead={() => undefined}
      />
    );
    const mounted = render(tree(HEAD), { wrapper: view.wrapper });
    expect(
      marker(await screen.findByRole("region", { name: `Source of ${PATH}` })),
    ).toHaveAttribute("data-diff-head-sha", HEAD);
    mounted.rerender(tree(NEXT_HEAD));
    const source = screen.getByRole("region", { name: `Source of ${PATH}` });
    expect(marker(source)).toHaveAttribute("data-diff-context-pending", "true");
    expect(
      source.querySelector(
        '[data-diff-head-sha="' +
          NEXT_HEAD +
          '"]:not([data-diff-context-pending="true"])',
      ),
    ).toBeNull();
    await act(async () => {
      finish(bytes(""));
    });
    await waitFor(() => expect(source).toHaveTextContent("Empty file"));
    expect(marker(source)).toHaveAttribute(
      "data-diff-after-revision",
      NEXT_HEAD,
    );
    expect(marker(source)).not.toHaveAttribute(
      "data-diff-context-pending",
      "true",
    );
  });
});

describe("non-code MR Diff provenance", () => {
  it.each([
    {
      name: "binary",
      text: `diff --git a/${PATH} b/${PATH}\nBinary files a/${PATH} and b/${PATH} differ\n`,
      isBinary: true,
      message: "Binary file — no text diff available",
    },
    { name: "empty", text: "", isBinary: false, message: "No changes to show" },
    {
      name: "header-only",
      text: `diff --git a/${PATH} b/${PATH}\nold mode 100644\nnew mode 100755\n`,
      isBinary: false,
      message: "File is now executable",
    },
  ])(
    "keeps a file identity on a $name normal Diff arm",
    async ({ text, isBinary, message }) => {
      const view = setup();
      render(
        <PrFilesPane
          files={[{ path: PATH, additions: 0, deletions: 0 }]}
          effectivePath={PATH}
          onSelectPath={() => undefined}
          fileDiff={{ filePath: PATH, text, isBinary, isTruncated: false }}
          isPending={false}
          isError={false}
          isFetching={false}
          repoPath={REPO}
          lens="origin"
          number={7}
          blameRev={HEAD}
          provider="gitlab"
        />,
        { wrapper: view.wrapper },
      );
      await screen.findByText(message);
      const painted = document.querySelector<HTMLElement>(
        "[data-diff-file-path]",
      );
      expect(painted).not.toBeNull();
      expect(painted).toHaveAttribute("data-diff-file-path", PATH);
      expect(painted).toHaveAttribute("data-diff-head-sha", HEAD);
      expect(painted).not.toHaveAttribute("data-diff-context-pending", "true");
    },
  );

  it.each(["binary", "empty"])(
    "retains the authoritative pair on a %s Full file arm",
    async (kind) => {
      const view = setup();
      view.client.setQueryData(
        prSnapshotComparisonOptions(REPO, 7, HEAD, PATH, "origin").queryKey,
        {
          baseSha: BASE,
          headSha: HEAD,
          oldPath: PATH,
          newPath: PATH,
          before: bytes(kind === "empty" ? "" : "\0before"),
          after: bytes(kind === "empty" ? "" : "\0after"),
          patch: "",
        },
      );
      render(
        <PrFullFileDiff
          repoPath={REPO}
          number={7}
          headSha={HEAD}
          path={PATH}
          lens="origin"
          reportRead={() => undefined}
        />,
        { wrapper: view.wrapper },
      );
      const full = await screen.findByRole("region", {
        name: `Full comparison of ${PATH}`,
      });
      await waitFor(() =>
        expect(full).toHaveTextContent(
          kind === "empty"
            ? "Both versions are empty."
            : "Full comparison is unavailable for binary",
        ),
      );
      const painted = marker(full);
      expect(painted).toHaveAttribute("data-diff-head-sha", HEAD);
      expect(painted).toHaveAttribute("data-diff-before-path", PATH);
      expect(painted).toHaveAttribute("data-diff-before-revision", BASE);
      expect(painted).toHaveAttribute("data-diff-after-path", PATH);
      expect(painted).toHaveAttribute("data-diff-after-revision", HEAD);
    },
  );
});
