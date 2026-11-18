import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toaster } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "@/App";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";

const updater = vi.hoisted(() => ({
  check: vi.fn(async () => ({ version: "99.0.0", close: vi.fn() })),
}));

vi.mock("@tauri-apps/plugin-updater", () => updater);
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(async () => "0.99.0"),
  getTauriVersion: vi.fn(async () => "2.10.0"),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: async () => () => undefined,
  }),
}));
vi.mock("@/lib/settings/api", async (original) => ({
  ...(await original<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/queries", async (original) => ({
  ...(await original<typeof import("@/lib/git/queries")>()),
  useGitInstalled: () => ({
    isSuccess: true,
    isPending: false,
    isError: false,
  }),
}));
vi.mock("@/lib/git/queries/gitlab-work", () => ({
  useGitLabWorkBackground: () => undefined,
}));
vi.mock("@/lib/last-checkout/subscribe", () => ({}));
vi.mock("@/lib/analytics", async (original) => ({
  ...(await original<typeof import("@/lib/analytics")>()),
  syncAnalytics: async () => undefined,
  track: () => undefined,
}));
vi.mock("@/lib/automations/store", async (original) => {
  const actual = await original<typeof import("@/lib/automations/store")>();
  return {
    ...actual,
    loadAutomations: vi.fn(async () => actual.normalizeAutomations(undefined)),
  };
});
vi.mock("@/lib/automations/useBackgroundPrSync", () => ({
  useBackgroundPrSync: () => undefined,
}));
vi.mock("@/lib/parked-writes", () => ({
  useQuitGuard: () => undefined,
}));
vi.mock("@/features/app-menu/useMacAppMenu", () => ({
  useMacAppMenu: () => undefined,
}));
vi.mock("@/features/welcome/useRepoDrop", () => ({
  useRepoDrop: () => undefined,
}));
vi.mock("@/features/repository/useOpenRepoByPath", () => ({
  usePickAndOpenRepo: () => () => undefined,
  useOpenWorktree: () => async () => true,
  repoOpenWatermark: () => () => true,
}));

// Keep the app shell, welcome page, Settings and What's new real; unrelated
// repository, forge and agent panels have independent native dependencies.
vi.mock("@/features/mywork/MyWorkScreen", () => ({
  MyWorkScreen: () => null,
}));
vi.mock("@/features/mywork/WorkDocumentBar", () => ({
  WorkDocumentBar: () => null,
  useWorkTabNavigation: () => undefined,
  closeDocumentTab: async () => undefined,
}));
vi.mock("@/features/mywork/ConnectWorkRepoDialog", () => ({
  ConnectWorkRepoDialog: () => null,
}));
vi.mock("@/features/repository/RepositoryView", () => ({
  RepositoryView: () => null,
}));
vi.mock("@/features/explore/ExploreScreen", () => ({
  ExploreScreen: () => null,
}));
vi.mock("@/features/help/HelpScreen", () => ({ HelpScreen: () => null }));
vi.mock("@/features/activity/ActivityDock", () => ({
  ActivityStrip: () => null,
}));
vi.mock("@/features/automations/AutomationHistoryDialog", () => ({
  AutomationHistoryDialogHost: () => null,
}));
vi.mock("@/features/automations/AutomationResultDialog", () => ({
  AutomationResultDialog: () => null,
}));
vi.mock("@/features/notifications/RepoNotificationsDialog", () => ({
  RepoNotificationsDialogHost: () => null,
}));
vi.mock("@/features/accounts/ReconnectDialog", () => ({
  ReconnectDialog: () => null,
}));
vi.mock("@/features/welcome/CloneRepoDialog", () => ({
  CloneRepoDialog: () => null,
}));
vi.mock("@/features/welcome/CreateRepoDialog", () => ({
  CreateRepoDialog: () => null,
}));
vi.mock("@/features/shortcuts/CommandPalette", () => ({
  CommandPalette: () => null,
}));
vi.mock("@/features/shortcuts/ShortcutsDialog", () => ({
  ShortcutsDialog: () => null,
}));

let client: QueryClient;

beforeEach(() => {
  useUiStore.setState(useUiStore.getInitialState(), true);
  useUiStore.setState({ view: "welcome" });
  const settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    autoCheckUpdates: true,
    seenAnalyticsNotice: true,
    seenGuideNudge: true,
    lastSeenVersion: "0.99.0",
    recentRepos: [],
  };
  vi.mocked(loadSettings).mockResolvedValue(settings);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  client.setQueryData(settingsKeys.settings, settings);
});

afterEach(() => {
  client.clear();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  vi.useRealTimers();
});

function show() {
  return render(
    <QueryClientProvider client={client}>
      <App />
      <Toaster />
    </QueryClientProvider>,
  );
}

describe("App self-update removal", () => {
  it("reads the installed version without checking releases on launch or later", async () => {
    vi.useFakeTimers();
    const mounted = show();
    await act(async () => {
      await Promise.resolve();
    });

    expect(getVersion).toHaveBeenCalled();
    expect(updater.check).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000);
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });

    expect(updater.check).not.toHaveBeenCalled();
    expect(screen.queryByText(/Update available/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Install.*restart/ }),
    ).toBeNull();
    mounted.unmount();
  });

  it("keeps Settings reachable without update check or download controls", async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: "Settings" }));

    const sections = await screen.findByRole("navigation", {
      name: "Settings sections",
    });
    expect(
      within(sections).getByRole("button", { name: "About" }),
    ).toBeVisible();
    expect(
      within(sections).queryByRole("button", { name: "Updates" }),
    ).toBeNull();
    expect(screen.queryByText(/Check for updates/)).toBeNull();
    expect(screen.queryByText(/Install.*restart/)).toBeNull();
    expect(updater.check).not.toHaveBeenCalled();
  });

  it("ignores a cached release without badging Settings or offering installation", async () => {
    vi.useFakeTimers();
    client.setQueryData(["app-update"], { version: "99.0.0" });
    const mounted = show();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(screen.getByRole("button", { name: "Settings" })).toBeVisible();
    expect(screen.queryByText(/Update available/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Install.*restart/ }),
    ).toBeNull();
    expect(updater.check).not.toHaveBeenCalled();
    mounted.unmount();
  });
});
