import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PrFullFileDiff } from "@/features/pulls/PrFullFileDiff";
import { PrFilesPane } from "@/features/pulls/RemotePrViewParts";
import { gitObjectsPresent } from "@/lib/git/api";
import {
  gitPrSnapshotComparison,
  gitPrSnapshotFiles,
} from "@/lib/git/api/pr-snapshot";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { stubCanvas } from "./canvas-stub";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitObjectsPresent: vi.fn(),
}));
vi.mock("@/lib/git/api/pr-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api/pr-snapshot")>()),
  gitPrSnapshotFiles: vi.fn(),
  gitPrSnapshotComparison: vi.fn(),
}));

const REPO = "/repo";
const HEAD = "abcdef0123".repeat(4);
const BASE = "fedcba9876".repeat(4);
const PATH = "src/app/lang/directoryIntegration/index-en_US.ts";
const comparison = vi.mocked(gitPrSnapshotComparison);
const snapshot = vi.mocked(gitPrSnapshotFiles);
const clients: QueryClient[] = [];
beforeAll(stubCanvas);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(gitObjectsPresent).mockResolvedValue(false);
  snapshot.mockResolvedValue([{ path: PATH, undecodable: false }]);
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
});

function pair(text: string) {
  const data = {
    base64: btoa(text),
    mime: null,
    tooLarge: false,
    size: text.length,
  };
  return {
    baseSha: BASE,
    headSha: HEAD,
    oldPath: PATH,
    newPath: PATH,
    before: data,
    after: data,
    patch: "",
  };
}

function client(mode: "split" | "unified" = "unified") {
  const value = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(value);
  value.setQueryData(settingsKeys.settings, {
    ...DEFAULT_SETTINGS,
    diffViewMode: mode,
  });
  return value;
}

function mountComparison(mode: "split" | "unified" = "unified") {
  const reportRead = vi.fn();
  render(
    <QueryClientProvider client={client(mode)}>
      <PrFullFileDiff
        repoPath={REPO}
        number={7}
        headSha={HEAD}
        path={PATH}
        lens="origin"
        reportRead={reportRead}
      />
    </QueryClientProvider>,
  );
  return reportRead;
}

describe("full file comparison loading and identical versions", () => {
  it.each(["added", "deleted"] as const)(
    "renders a highlighted TypeScript %s file with an absent opposite side",
    async (change) => {
      const text =
        'export const localeTitle = "Directory integration";\nexport const enabled = true;\n';
      const data = pair(text);
      comparison.mockResolvedValueOnce({
        ...data,
        oldPath: change === "added" ? null : PATH,
        newPath: change === "deleted" ? null : PATH,
        before: change === "added" ? null : data.before,
        after: change === "deleted" ? null : data.after,
        patch: null,
      });
      mountComparison("split");
      // A fresh worker loads the lazy renderer before this group can mount.
      const rendered = await screen.findByRole(
        "group",
        { name: `Diff of ${PATH}` },
        { timeout: 5_000 },
      );

      await waitFor(() =>
        expect(rendered).toHaveTextContent("Directory integration"),
      );

      expect(rendered).toHaveTextContent("enabled");
      const operator = change === "added" ? "+" : "-";
      const opposite = change === "added" ? "-" : "+";
      expect(
        rendered.querySelectorAll(`[data-operator="${operator}"]`),
      ).toHaveLength(2);
      expect(
        rendered.querySelector(`[data-operator="${opposite}"]`),
      ).toBeNull();
      expect(comparison).toHaveBeenCalledExactlyOnceWith(
        REPO,
        7,
        HEAD,
        PATH,
        "origin",
      );
    },
  );

  it.each(["unified", "split"] as const)(
    "renders both complete identical nonempty versions with an empty native patch in %s",
    async (mode) => {
      comparison.mockResolvedValueOnce(
        pair('export default {\n  title: "Directory integration",\n};\n'),
      );
      mountComparison(mode);
      const rendered = await screen.findByRole("group", {
        name: `Diff of ${PATH}`,
      });

      await waitFor(() =>
        expect(rendered).toHaveTextContent("Directory integration"),
      );

      expect(rendered.querySelectorAll("tr[data-line]").length).toBeGreaterThan(
        0,
      );
      expect(
        rendered.querySelector('[data-operator="+"], [data-operator="-"]'),
      ).toBeNull();
      expect(rendered.querySelector("td.diff-line-old-content") !== null).toBe(
        mode === "split",
      );
      expect(screen.queryByText("No changes to show")).toBeNull();
    },
  );

  it("renders the last line of a locale-sized identical file beyond the preview cap", async () => {
    const text = `export default {\n${Array.from({ length: 450 }, (_, index) => `  "entry-${index}": "Directory integration ${index}",`).join("\n")}\n};\n`;
    comparison.mockResolvedValueOnce(pair(text));
    mountComparison("split");
    const rendered = await screen.findByRole("group", {
      name: `Diff of ${PATH}`,
    });

    await waitFor(() =>
      expect(rendered).toHaveTextContent("Directory integration 449"),
    );

    expect(rendered).toHaveTextContent("Directory integration 0");
    expect(screen.queryByRole("button", { name: "Show full diff" })).toBeNull();
  });

  it("refuses an equal file beyond the row budget with a visible explanation", async () => {
    comparison.mockResolvedValueOnce(
      pair(
        Array.from({ length: 5_100 }, (_, index) => `label-${index}`).join(
          "\n",
        ),
      ),
    );
    mountComparison();

    expect(
      await screen.findByText(
        "Full comparison is too large to display safely. Use Diff to review its changes.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("group", { name: `Diff of ${PATH}` })).toBeNull();
  });

  it("shows native pair loading explicitly with one filename until both versions arrive", async () => {
    let resolvePair!: (value: ReturnType<typeof pair>) => void;
    comparison.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePair = resolve;
        }),
    );
    const reportRead = mountComparison();
    const region = screen.getByRole("region", {
      name: `Full comparison of ${PATH}`,
    });

    expect(
      await within(region).findByText("Loading both file versions…"),
    ).toBeVisible();
    expect(within(region).getAllByText(/index-en_US\.ts$/)).toHaveLength(1);
    expect(reportRead).toHaveBeenLastCalledWith({
      placeholder: false,
      loading: true,
    });
    await act(async () => resolvePair(pair("ready text\n")));
    await waitFor(() => expect(region).toHaveTextContent("ready text"));
    expect(
      within(region).queryByText("Loading both file versions…"),
    ).toBeNull();
    expect(reportRead).toHaveBeenLastCalledWith({
      placeholder: false,
      loading: false,
    });
  });

  it("shows MR head preparation explicitly before requesting the native pair", async () => {
    let resolveHead!: (
      value: Awaited<ReturnType<typeof gitPrSnapshotFiles>>,
    ) => void;
    snapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHead = resolve;
        }),
    );
    comparison.mockResolvedValueOnce(pair("prepared text\n"));
    render(
      <QueryClientProvider client={client()}>
        <PrFilesPane
          files={[{ path: PATH, additions: 0, deletions: 0 }]}
          effectivePath={PATH}
          onSelectPath={vi.fn()}
          fileDiff={{
            filePath: PATH,
            text: "",
            isBinary: false,
            isTruncated: false,
          }}
          isPending={false}
          isError={false}
          isFetching={false}
          repoPath={REPO}
          lens="origin"
          number={7}
          blameRev={HEAD}
          provider="gitlab"
        />
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Full file" }));

    expect(await screen.findByText("Preparing the MR head…")).toBeVisible();
    expect(comparison).not.toHaveBeenCalled();
    await act(async () => resolveHead([{ path: PATH, undecodable: false }]));
    const full = await screen.findByRole("region", {
      name: `Full comparison of ${PATH}`,
    });
    await waitFor(() => expect(full).toHaveTextContent("prepared text"));
  });
});
