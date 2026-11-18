import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecentWorktreesPanel } from "@/features/welcome/RecentWorktreesPanel";
import { validateRepo } from "@/lib/git/api";
import {
  userWorktreesPeekOptions,
  useUserWorktreesPeek,
} from "@/lib/git/queries";
import { listUserWorktrees, type UserWorktree } from "@/lib/git/worktree";
import { loadSettings, type RecentRepo } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";

vi.mock("@/lib/settings/api", async (original) => ({
  ...(await original<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/worktree", async (original) => ({
  ...(await original<typeof import("@/lib/git/worktree")>()),
  listUserWorktrees: vi.fn(),
}));
vi.mock("@/lib/git/api", async (original) => ({
  ...(await original<typeof import("@/lib/git/api")>()),
  validateRepo: vi.fn(),
}));
vi.mock("@/features/repository/repo-shell-prefetch", async (original) => ({
  ...(await original<
    typeof import("@/features/repository/repo-shell-prefetch")
  >()),
  warmRepoShell: async () => undefined,
}));

Element.prototype.scrollIntoView ??= () => undefined;

const REPOS = ["alpha", "bravo", "alpha-alias"].map<RecentRepo>((name) => ({
  path: `/repos/${name}`,
  name,
  lastOpenedAt: "2026-11-17T01:00:00Z",
}));
const ACTIVITY = 1_800_000_000_000;

function worktree(
  branch: string,
  lastActivityMs: number | null = ACTIVITY,
  extra: Partial<UserWorktree> = {},
): UserWorktree {
  return {
    path: `/worktrees/${branch}`,
    branch,
    head: "a".repeat(40),
    isMain: false,
    isDetached: false,
    isLocked: false,
    lockReason: "",
    lastActivityMs,
    ...extra,
  };
}

let pages: Map<string, UserWorktree[] | Error>;

beforeEach(() => {
  pages = new Map();
  useUiStore.setState(useUiStore.getInitialState(), true);
  useUiStore.setState({ view: "welcome" });
  onlineManager.setOnline(true);
  vi.mocked(listUserWorktrees).mockReset();
  vi.mocked(listUserWorktrees).mockImplementation(async (path) => {
    const result = pages.get(path) ?? [];
    if (result instanceof Error) throw result;
    return result;
  });
  vi.mocked(validateRepo).mockImplementation(async (path) => ({
    root: path,
    name: path.split("/").at(-1) ?? path,
  }));
});

afterEach(() => onlineManager.setOnline(true));

function Peer() {
  useUserWorktreesPeek(REPOS[0].path);
  return null;
}

function show(
  recents = REPOS,
  options?: { peer?: boolean; cached?: UserWorktree[] },
) {
  const settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    recentRepos: recents,
  };
  vi.mocked(loadSettings).mockResolvedValue(settings);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  client.setQueryData(settingsKeys.settings, settings);
  if (options?.cached) {
    client.setQueryData(
      userWorktreesPeekOptions(REPOS[0].path).queryKey,
      options.cached,
      { updatedAt: 1 },
    );
  }
  render(
    <QueryClientProvider client={client}>
      {options?.peer && <Peer />}
      <RecentWorktreesPanel />
    </QueryClientProvider>,
  );
  return client;
}

const rowLabels = () =>
  within(screen.getByRole("listbox", { name: "Recent worktrees" }))
    .getAllByRole("option")
    .map((row) => row.textContent);

describe("Recent worktrees panel", () => {
  it("shows the latest 20 unique linked worktrees, excluding main and session workspaces", async () => {
    pages.set(REPOS[0].path, [
      ...Array.from({ length: 23 }, (_, index) =>
        worktree(`branch-${index + 1}`, ACTIVITY + index),
      ),
      worktree("main-workspace", ACTIVITY + 500, { isMain: true }),
      worktree("GD/Session/hidden", ACTIVITY + 600),
    ]);
    pages.set(REPOS[2].path, [
      worktree("branch-23", ACTIVITY + 22, {
        path: "\\WORKTREES\\BRANCH-23",
      }),
    ]);
    show();

    await screen.findByText("branch-23");
    await waitFor(() => expect(listUserWorktrees).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(rowLabels()).toEqual(
      Array.from({ length: 20 }, (_, index) =>
        expect.stringContaining(`branch-${23 - index}`),
      ),
    );
    expect(screen.queryByText("main-workspace")).toBeNull();
    expect(screen.queryByText("GD/Session/hidden")).toBeNull();
  });

  it("keeps timestamp ties stable and puts unknown activity last without inventing dates", async () => {
    pages.set(REPOS[0].path, [
      worktree("same-first"),
      worktree("unknown-first", null),
      worktree("same-second"),
      worktree("unknown-second", Number.POSITIVE_INFINITY),
    ]);
    show([REPOS[0]]);

    await screen.findByText("same-first");
    expect(rowLabels()).toEqual(
      ["same-first", "same-second", "unknown-first", "unknown-second"].map(
        (branch) => expect.stringContaining(branch),
      ),
    );
    const rows = screen.getAllByRole("option");
    expect(rows[0].querySelector("time")).toHaveAttribute(
      "datetime",
      new Date(ACTIVITY).toISOString(),
    );
    expect(rows[2].querySelector("time")).toBeNull();
    expect(rows[3].querySelector("time")).toBeNull();
  });

  it("shares passive peek reads with another observer and loads worktrees offline", async () => {
    pages.set(REPOS[0].path, [worktree("offline-local")]);
    onlineManager.setOnline(false);
    show([REPOS[0]], { peer: true });

    await screen.findByText("offline-local");
    expect(listUserWorktrees).toHaveBeenCalledTimes(1);
    expect(listUserWorktrees).toHaveBeenCalledWith(REPOS[0].path, {
      prune: false,
    });
  });

  it.each(["click", "keyboard"])(
    "opens the exact worktree path via %s",
    async (mode) => {
      const exact = "/worktrees/Exact Workspace";
      pages.set(REPOS[0].path, [
        worktree("feature/exact", ACTIVITY, { path: exact }),
      ]);
      const user = userEvent.setup();
      show([REPOS[0]]);
      const row = await screen.findByRole("option", { name: /feature\/exact/ });

      if (mode === "click") await user.click(row);
      else {
        act(() => row.focus());
        await user.keyboard("{ArrowDown}{Enter}");
      }

      await waitFor(() => expect(useUiStore.getState().repoPath).toBe(exact));
      expect(validateRepo).toHaveBeenCalledWith(exact);
      expect(useUiStore.getState().view).toBe("repo");
      expect(
        useUiStore
          .getState()
          .workDocuments.repositories?.some((repo) => repo.repoPath === exact),
      ).toBe(true);
    },
  );

  it("retains loaded rows when one repository fails and offers a retry", async () => {
    pages.set(REPOS[0].path, new Error("Disconnected drive"));
    pages.set(REPOS[1].path, [worktree("available")]);
    const user = userEvent.setup();
    show(REPOS.slice(0, 2), { cached: [worktree("cached")] });

    await screen.findByText(/couldn.t load.*worktrees/i);
    expect(screen.getByText("cached")).toBeVisible();
    expect(screen.getByText("available")).toBeVisible();
    expect(screen.queryByText(/No linked worktrees/i)).toBeNull();
    pages.set(REPOS[0].path, [worktree("recovered")]);
    await user.click(screen.getByRole("button", { name: "Retry" }));

    await screen.findByText("recovered");
    await waitFor(() =>
      expect(screen.queryByText(/couldn.t load.*worktrees/i)).toBeNull(),
    );
  });

  it("shows loading until successful empty reads finish", async () => {
    let finish!: (rows: UserWorktree[]) => void;
    vi.mocked(listUserWorktrees).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    show([REPOS[0]]);

    expect(screen.getByRole("status")).toHaveTextContent(
      /Loading recent worktrees/i,
    );
    expect(screen.queryByText(/No linked worktrees/i)).toBeNull();
    await act(async () => finish([]));
    expect(await screen.findByText(/No linked worktrees/i)).toBeVisible();
  });
});
