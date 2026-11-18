import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelActivityBoundary } from "@/components/panel-portal";
import {
  usePrDiffContext,
  usePrDiffContextWarmup,
} from "@/features/pulls/usePrDiffContext";
import {
  gitPrSnapshotComparison,
  type PrSnapshotComparison,
} from "@/lib/git/api/pr-snapshot";
import type { FileDiff } from "@/lib/git/types";

vi.mock("@/lib/git/api/pr-snapshot", async (original) => ({
  ...(await original<typeof import("@/lib/git/api/pr-snapshot")>()),
  gitPrSnapshotComparison: vi.fn(),
}));

const REPO = "/request-checkout";
const HEAD = "abcdef0123".repeat(4);
const NEXT_HEAD = "123456789a".repeat(4);
const BASE = "fedcba9876".repeat(4);
const PATH = "src/request.txt";
const OTHER = "src/other.txt";
const comparison = vi.mocked(gitPrSnapshotComparison);
const clients: QueryClient[] = [];

function fixture(path = PATH, headSha = HEAD, label = "MR") {
  const before = `${label} first\n${label} old\n${label} last\n`;
  const after = `${label} first\n${label} new\n${label} last\n`;
  const oldPath = JSON.stringify(`a/${path}`);
  const newPath = JSON.stringify(`b/${path}`);
  const text = `diff --git ${oldPath} ${newPath}\n--- ${oldPath}\n+++ ${newPath}\n@@ -2 +2 @@\n-${label} old\n+${label} new\n`;
  const bytes = (value: string) => ({
    base64: btoa(value),
    mime: null,
    tooLarge: false,
    size: value.length,
  });
  const diff: FileDiff = {
    filePath: path,
    text,
    isBinary: false,
    isTruncated: false,
  };
  const pair: PrSnapshotComparison = {
    baseSha: BASE,
    headSha,
    oldPath: path,
    newPath: path,
    before: bytes(before),
    after: bytes(after),
    patch: text,
  };
  return { diff, pair };
}

type Target = Parameters<typeof usePrDiffContextWarmup>[0];
type Props = { target: Target; consumer?: FileDiff; active?: boolean };

function Warmup({ target }: { target: Target }) {
  usePrDiffContextWarmup(target);
  return null;
}

function Consumer({ target, data }: { target: Target; data: FileDiff }) {
  const resource = usePrDiffContext({
    ...target,
    path: data.filePath,
    data,
    composerOpen: false,
  });
  return (
    <output aria-label="Verified nearby code">
      {resource.context?.content.new ?? resource.state}
    </output>
  );
}

function Harness({ target, consumer, active = true }: Props) {
  return (
    <PanelActivityBoundary active={active}>
      <Warmup target={target} />
      {consumer && <Consumer target={target} data={consumer} />}
    </PanelActivityBoundary>
  );
}

function mount(overrides: Partial<Props> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  let props: Props = {
    target: {
      repoPath: REPO,
      number: 17,
      headSha: HEAD,
      lens: "origin",
      path: PATH,
      enabled: true,
    },
    ...overrides,
  };
  const view = render(
    <QueryClientProvider client={client}>
      <Harness {...props} />
    </QueryClientProvider>,
  );
  return {
    ...view,
    update(next: Partial<Props>) {
      props = { ...props, ...next };
      view.rerender(
        <QueryClientProvider client={client}>
          <Harness {...props} />
        </QueryClientProvider>,
      );
    },
    target: props.target,
  };
}

beforeEach(() => {
  comparison.mockReset().mockResolvedValue(fixture().pair);
  onlineManager.setOnline(true);
});

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  onlineManager.setOnline(true);
});

describe("MR selected-file context warmup", () => {
  it("starts before the diff consumer mounts and shares the pending read", async () => {
    let resolvePair!: (pair: PrSnapshotComparison) => void;
    comparison.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePair = resolve;
        }),
    );
    const view = mount();
    await waitFor(() =>
      expect(comparison).toHaveBeenCalledExactlyOnceWith(
        REPO,
        17,
        HEAD,
        PATH,
        "origin",
      ),
    );
    expect(screen.queryByRole("status")).toBeNull();

    view.update({ consumer: fixture().diff });
    expect(screen.getByLabelText("Verified nearby code")).toHaveTextContent(
      "loading",
    );
    await act(async () => resolvePair(fixture().pair));

    await waitFor(() =>
      expect(screen.getByLabelText("Verified nearby code")).toHaveTextContent(
        "MR first MR new MR last",
      ),
    );
    expect(comparison).toHaveBeenCalledTimes(1);
  });

  it("uses the prepared cache when the diff consumer opens later", async () => {
    let resolvePair!: (pair: PrSnapshotComparison) => void;
    comparison.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePair = resolve;
        }),
    );
    const view = mount();
    await waitFor(() => expect(comparison).toHaveBeenCalledTimes(1));
    await act(async () => resolvePair(fixture().pair));

    view.update({ consumer: fixture().diff });

    expect(screen.getByLabelText("Verified nearby code")).toHaveTextContent(
      "MR first MR new MR last",
    );
    expect(comparison).toHaveBeenCalledTimes(1);
  });

  it("waits for the MR panel to become active before preparing its selection", async () => {
    const view = mount({ active: false });
    expect(comparison).not.toHaveBeenCalled();

    view.update({ active: true });
    await waitFor(() => expect(comparison).toHaveBeenCalledTimes(1));
    const next = fixture(OTHER, NEXT_HEAD, "NEXT");
    comparison.mockResolvedValue(next.pair);
    view.update({
      active: false,
      target: { ...view.target, path: OTHER, headSha: NEXT_HEAD },
    });
    expect(comparison).toHaveBeenCalledTimes(1);

    view.update({ active: true, consumer: next.diff });

    await waitFor(() =>
      expect(screen.getByLabelText("Verified nearby code")).toHaveTextContent(
        "NEXT first NEXT new NEXT last",
      ),
    );
    expect(comparison).toHaveBeenLastCalledWith(
      REPO,
      17,
      NEXT_HEAD,
      OTHER,
      "origin",
    );
    expect(comparison).toHaveBeenCalledTimes(2);
  });

  it("keeps a late earlier selection out of the next selected file", async () => {
    let resolveFirst!: (pair: PrSnapshotComparison) => void;
    const first = new Promise<PrSnapshotComparison>((resolve) => {
      resolveFirst = resolve;
    });
    const next = fixture(OTHER, NEXT_HEAD, "NEXT");
    comparison.mockImplementation((_repo, _number, head, path) =>
      head === NEXT_HEAD && path === OTHER ? Promise.resolve(next.pair) : first,
    );
    const view = mount();
    await waitFor(() => expect(comparison).toHaveBeenCalledTimes(1));

    view.update({
      target: { ...view.target, path: OTHER, headSha: NEXT_HEAD },
      consumer: next.diff,
    });
    await act(async () => resolveFirst(fixture().pair));

    await waitFor(() =>
      expect(screen.getByLabelText("Verified nearby code")).toHaveTextContent(
        "NEXT first NEXT new NEXT last",
      ),
    );
    expect(screen.getByLabelText("Verified nearby code")).not.toHaveTextContent(
      "MR first",
    );
    expect(comparison).toHaveBeenCalledTimes(2);
  });

  it.each<Partial<Target>>([
    { enabled: false },
    { repoPath: "" },
    { number: 0 },
    { number: -1 },
    { number: 1.5 },
    { headSha: null },
    { headSha: "short" },
    { lens: "upstream" },
    { path: null },
    { path: "" },
    { path: "/absolute/file.ts" },
    { path: "C:/absolute/file.ts" },
    { path: "../outside.ts" },
    { path: "src/../outside.ts" },
    { path: "src//file.ts" },
    { path: "src/./file.ts" },
    { path: "src/zero\0.ts" },
  ])("does not warm an ineligible target %j", (overrides) => {
    mount({
      target: {
        repoPath: REPO,
        number: 17,
        headSha: HEAD,
        lens: "origin",
        path: PATH,
        enabled: true,
        ...overrides,
      },
    });

    expect(comparison).not.toHaveBeenCalled();
  });

  it("accepts a SHA-256 head for a selected file", async () => {
    const headSha = "abcdef0123456789".repeat(4);
    const data = fixture(PATH, headSha);
    comparison.mockResolvedValue(data.pair);
    mount({
      target: {
        repoPath: REPO,
        number: 17,
        headSha,
        lens: "origin",
        path: PATH,
        enabled: true,
      },
      consumer: data.diff,
    });

    await waitFor(() =>
      expect(screen.getByLabelText("Verified nearby code")).toHaveTextContent(
        "MR first MR new MR last",
      ),
    );
    expect(comparison).toHaveBeenCalledExactlyOnceWith(
      REPO,
      17,
      headSha,
      PATH,
      "origin",
    );
  });

  it("preserves a literal interior backslash in a Git file name", async () => {
    const path = "src/literal\\name.txt";
    const data = fixture(path);
    comparison.mockResolvedValue(data.pair);
    mount({
      target: {
        repoPath: REPO,
        number: 17,
        headSha: HEAD,
        lens: "origin",
        path,
        enabled: true,
      },
      consumer: data.diff,
    });

    await waitFor(() =>
      expect(screen.getByLabelText("Verified nearby code")).toHaveTextContent(
        "MR first MR new MR last",
      ),
    );
    expect(comparison).toHaveBeenCalledExactlyOnceWith(
      REPO,
      17,
      HEAD,
      "src/literal\\name.txt",
      "origin",
    );
  });
});
