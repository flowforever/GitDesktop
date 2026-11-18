import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WelcomeScreen } from "@/features/welcome/WelcomeScreen";
import { loadSettings, type RecentRepo } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";

vi.mock("@/lib/settings/api", async (original) => ({
  ...(await original<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/last-checkout/store", async (original) => ({
  ...(await original<typeof import("@/lib/last-checkout/store")>()),
  lastCheckoutReady: vi.fn(async () => undefined),
}));
vi.mock("@/lib/git/worktree", async (original) => ({
  ...(await original<typeof import("@/lib/git/worktree")>()),
  listUserWorktrees: vi.fn(async () => []),
}));

// jsdom has no scrolling implementation; the real repository filter scrolls rows.
Element.prototype.scrollIntoView ??= () => undefined;

const RECENTS = ["alpha", "bravo"].map<RecentRepo>((name) => ({
  path: `/repos/${name}`,
  name,
  repoName: name,
  owner: "team",
  host: "git.test",
  provider: "gitlab",
  visibility: "private",
  isFork: false,
  lastOpenedAt: "2026-11-17T01:00:00Z",
}));
const ACTION_NAMES = [
  /^Open repository/,
  /^Clone repository/,
  /^Create repository/,
  /^My works/,
  /^Explore repositories/,
];

beforeEach(() => {
  useUiStore.setState(useUiStore.getInitialState(), true);
});

function show(recents: RecentRepo[] = RECENTS) {
  const settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    autoCheckUpdates: false,
    seenGuideNudge: true,
    recentRepos: recents,
  };
  vi.mocked(loadSettings).mockResolvedValue(settings);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, settings);
  client.setQueryData(
    ["repo-owners", recents.map((repo) => repo.path).sort()],
    recents.map((repo) => ({
      path: repo.path,
      owner: repo.owner,
      host: repo.host,
      provider: repo.provider,
      repoName: repo.repoName,
    })),
  );
  render(
    <QueryClientProvider client={client}>
      <WelcomeScreen />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

describe("Repositories chooser layout", () => {
  it("puts the repository list before the named action panel in reading order", () => {
    show();
    const filter = screen.getByRole("combobox", {
      name: "Filter repositories",
    });
    const open = screen.getByRole("button", { name: /^Open repository/ });

    expect(
      filter.compareDocumentPosition(open) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      within(screen.getByRole("region", { name: "Repositories" })).getByRole(
        "listbox",
        { name: "Repositories" },
      ),
    ).toBeVisible();
    const actions = screen.getByRole("complementary", {
      name: "Repository actions",
    });
    for (const name of ACTION_NAMES) {
      expect(within(actions).getByRole("button", { name })).toBeVisible();
    }
    const recentWorktrees = within(actions).getByRole("region", {
      name: "Recent worktrees",
    });
    expect(
      open.compareDocumentPosition(recentWorktrees) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("keeps the empty repository state first and every launcher reachable", async () => {
    const user = show([]);
    const empty = screen.getByText("No repositories yet");
    const open = screen.getByRole("button", { name: /^Open repository/ });

    expect(
      empty.compareDocumentPosition(open) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(empty).toBeVisible();
    const actions = screen.getByRole("complementary", {
      name: "Repository actions",
    });
    for (const name of ACTION_NAMES) {
      expect(within(actions).getByRole("button", { name })).toBeEnabled();
    }
    await user.tab();
    await user.tab();
    await user.tab();
    expect(open).toHaveFocus();
  });

  it("keeps the filter and action panel usable when no repositories match", async () => {
    const user = show();
    const filter = screen.getByRole("combobox", {
      name: "Filter repositories",
    });

    await user.type(filter, "no such repository");

    expect(screen.getByText("No repositories match.")).toBeVisible();
    expect(filter).toHaveFocus();
    expect(screen.queryByRole("option")).toBeNull();
    expect(
      within(
        screen.getByRole("complementary", { name: "Repository actions" }),
      ).getByRole("button", { name: /^Open repository/ }),
    ).toBeVisible();
  });
});
