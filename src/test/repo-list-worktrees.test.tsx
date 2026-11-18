import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepoList } from "@/features/repository/RepoList";
import { userWorktreesPeekOptions } from "@/lib/git/queries/worktrees";
import type { UserWorktree } from "@/lib/git/worktree";
import {
  type AppSettings,
  DEFAULT_SETTINGS,
  loadSettings,
  type RecentRepo,
} from "@/lib/settings/api";
import { settingsKeys } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { getTransport, installTransport } from "@/lib/transport";

const { openRecent, openExact } = vi.hoisted(() => ({
  openRecent: vi.fn(async () => false),
  openExact: vi.fn<(path: string) => Promise<boolean>>(),
}));
vi.mock("@/features/repository/useOpenRepoByPath", () => ({
  useOpenRepoByPath: () => openRecent,
  useOpenWorktree: () => openExact,
}));
vi.mock("@/lib/last-checkout/hint", () => ({ useReopenHint: () => null }));
vi.mock("@/lib/settings/api", async (original) => ({
  ...(await original<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

const ROOT = "/repos/alpha";
const LINKED = "/worktrees/alpha-auth";
const record = (name: string): RecentRepo => ({
  path: `/repos/${name}`,
  name,
  owner: "team",
  repoName: name,
  host: "git.test",
  provider: "gitlab",
  visibility: "private",
  isFork: false,
  lastOpenedAt: "2026-11-18T01:00:00Z",
});
const RECENTS = [record("alpha"), record("bravo")];
const tree = (path: string, branch: string, isMain = false): UserWorktree => ({
  path,
  branch,
  isMain,
  isDetached: branch === "",
  head: "a".repeat(40),
  isLocked: false,
  lockReason: "",
  lastActivityMs: null,
});
const TREES = [
  tree(ROOT, "main", true),
  tree(LINKED, "fix/auth"),
  tree("/sessions/hidden", "GD/Session/secret"),
];
const clients: QueryClient[] = [];
let previousTransport: ReturnType<typeof getTransport>;
let previousOnline: boolean;
let calls: { command: string; args?: Record<string, unknown> }[];
let readTrees: () => Promise<UserWorktree[]>;

Element.prototype.scrollIntoView ??= () => undefined;

beforeEach(() => {
  vi.clearAllMocks();
  openRecent.mockResolvedValue(false);
  openExact.mockImplementation(async (path) => {
    useUiStore
      .getState()
      .openRepo({ root: path, name: path.split("/").at(-1) ?? path });
    return true;
  });
  useUiStore.setState(useUiStore.getInitialState(), true);
  calls = [];
  readTrees = async () => TREES;
  previousOnline = onlineManager.isOnline();
  previousTransport = getTransport();
  installTransport({
    async invoke<T>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> {
      calls.push({ command, args });
      if (command === "git_worktree_list_user") return (await readTrees()) as T;
      throw new Error(`Unexpected command: ${command}`);
    },
  });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  onlineManager.setOnline(previousOnline);
  installTransport(previousTransport);
});

function show(showWorktrees = true) {
  const settings: AppSettings = {
    ...structuredClone(DEFAULT_SETTINGS),
    recentRepos: RECENTS,
  };
  vi.mocked(loadSettings).mockResolvedValue(settings);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  client.setQueryData(settingsKeys.settings, settings);
  client.setQueryData(
    ["repo-owners", RECENTS.map((repo) => repo.path).sort()],
    RECENTS.map((repo) => ({
      path: repo.path,
      owner: repo.owner,
      host: repo.host,
      provider: repo.provider,
      repoName: repo.repoName,
    })),
  );
  render(
    <QueryClientProvider client={client}>
      <RepoList
        showWorktrees={showWorktrees}
        onAliasRepo={() => undefined}
        onRemoveRepo={() => undefined}
      />
    </QueryClientProvider>,
  );
  return { client, settings, user: userEvent.setup() };
}
const trigger = () =>
  screen.getByRole("button", { name: "Worktrees for alpha" });
const option = (name: string) =>
  screen.getByRole("option", { name: new RegExp(name) });

describe("repository row worktree dropdown", () => {
  it("keeps the dropdown opt-in for existing RepoList consumers", () => {
    show(false);
    expect(
      screen.queryByRole("button", { name: "Worktrees for alpha" }),
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  it.each([true, false])(
    "opens a passive worktree list without opening the repository (online: %s)",
    async (online) => {
      onlineManager.setOnline(online);
      const { user } = show();
      expect(calls).toEqual([]);
      expect(option("alpha")).not.toContainElement(trigger());

      await user.click(trigger());

      const main = await screen.findByRole("menuitem", {
        name: /Main workspace/,
      });
      expect(main).toHaveTextContent(ROOT);
      expect(
        screen.getByRole("menuitem", { name: /fix\/auth/ }),
      ).toHaveTextContent(LINKED);
      expect(screen.queryByText("GD/Session/secret")).toBeNull();
      expect(screen.queryByText("/sessions/hidden")).toBeNull();
      expect(calls).toEqual([
        {
          command: "git_worktree_list_user",
          args: { repoPath: ROOT, prune: false },
        },
      ]);
      expect(openRecent).not.toHaveBeenCalled();
      expect(openExact).not.toHaveBeenCalled();
    },
  );

  it("opens the exact keyboard-selected worktree in its own app tab", async () => {
    useUiStore
      .getState()
      .openRepo({ root: "/repos/previous", name: "previous" });
    const { user } = show();
    trigger().focus();
    await user.keyboard("{ArrowDown}");
    await screen.findByRole("menuitem", { name: /fix\/auth/ });
    // Item registration and the menu's keyboard focus settle separately from
    // the asynchronous data paint.
    await waitFor(() =>
      expect(
        screen.getByRole("menuitem", { name: /Main workspace/ }),
      ).toHaveFocus(),
    );

    await user.keyboard("{End}{Enter}");

    await waitFor(() => expect(openExact).toHaveBeenCalledWith(LINKED));
    expect(openRecent).not.toHaveBeenCalled();
    expect(useUiStore.getState().repoPath).toBe(LINKED);
    expect(
      useUiStore
        .getState()
        .workDocuments.repositories?.map((repo) => repo.repoPath),
    ).toEqual(["/repos/previous", LINKED]);
  });

  it("shows loading until the local read answers", async () => {
    let finish!: (trees: UserWorktree[]) => void;
    readTrees = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const { user } = show();
    await user.click(trigger());
    expect(await screen.findByText("Loading worktrees…")).toBeVisible();

    await act(async () => finish(TREES));

    expect(
      await screen.findByRole("menuitem", { name: /fix\/auth/ }),
    ).toBeVisible();
  });

  it("shows a local-read failure and offers Retry", async () => {
    readTrees = async () => {
      throw new Error("Unavailable path");
    };
    const { user } = show();
    await user.click(trigger());

    expect(await screen.findByText("Couldn't load worktrees.")).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Retry" })).toBeEnabled();
    expect(openExact).not.toHaveBeenCalled();
  });

  it("explains an empty worktree list without guessing a main checkout", async () => {
    readTrees = async () => [];
    const { user } = show();
    await user.click(trigger());

    expect(await screen.findByText("No worktrees found.")).toBeVisible();
    expect(
      screen.queryByRole("menuitem", { name: /Main workspace/ }),
    ).toBeNull();
  });

  it("holds the shown menu entries through asynchronous query updates", async () => {
    const { client, user } = show();
    await user.click(trigger());
    await screen.findByRole("menuitem", { name: /fix\/auth/ });

    act(() =>
      client.setQueryData(userWorktreesPeekOptions(ROOT).queryKey, [
        TREES[0],
        tree("/worktrees/new", "feature/new"),
      ]),
    );

    expect(screen.getByRole("menuitem", { name: /fix\/auth/ })).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: /feature\/new/ })).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await user.click(trigger());
    expect(
      await screen.findByRole("menuitem", { name: /feature\/new/ }),
    ).toBeVisible();
  });

  it("preserves filter navigation and the Shift-open main-workspace escape", async () => {
    const { user } = show();
    const filter = screen.getByRole("combobox", {
      name: "Filter repositories",
    });
    await user.click(filter);
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() =>
      expect(openRecent).toHaveBeenCalledWith(ROOT, "recent", undefined, {
        preferMain: false,
      }),
    );
    openRecent.mockClear();

    fireEvent.click(option("alpha"), { shiftKey: true });

    await waitFor(() =>
      expect(openRecent).toHaveBeenCalledWith(ROOT, "recent", undefined, {
        preferMain: true,
      }),
    );
    expect(openExact).not.toHaveBeenCalled();
  });

  it("keeps row order and blocks competing opens while exact navigation is pending", async () => {
    let finish!: (opened: boolean) => void;
    openExact.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { client, settings, user } = show();
    await user.click(trigger());
    await user.click(
      await screen.findByRole("menuitem", { name: /fix\/auth/ }),
    );
    await waitFor(() => expect(openExact).toHaveBeenCalledWith(LINKED));

    act(() =>
      client.setQueryData(settingsKeys.settings, {
        ...settings,
        recentRepos: [...RECENTS].reverse(),
      }),
    );

    expect(
      screen
        .getAllByRole("option")
        .map((row) => within(row).getByText(/^(alpha|bravo)$/).textContent),
    ).toEqual(["alpha", "bravo"]);
    expect(option("alpha")).toBeDisabled();
    expect(option("bravo")).toBeDisabled();
    expect(trigger()).toBeDisabled();
    await act(async () => finish(false));
    expect(option("alpha")).toBeEnabled();
  });
});
