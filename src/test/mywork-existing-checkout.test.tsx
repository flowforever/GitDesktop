import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { open as openDirectory } from "@tauri-apps/plugin-dialog";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectWorkRepoDialog } from "@/features/mywork/ConnectWorkRepoDialog";
import { MyWorkScreen } from "@/features/mywork/MyWorkScreen";
import { CloneRepoDialog } from "@/features/welcome/CloneRepoDialog";
import type { MyWorkItem, RepoInfo, RepoOrigin } from "@/lib/git/types";
import {
  type AppSettings,
  DEFAULT_SETTINGS,
  type RecentRepo,
} from "@/lib/settings/api";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { getTransport, installTransport } from "@/lib/transport";

const ROOT = "/work/ai-worker-review/jorm-lib";
const PARENT = "/work/ai-worker-review";
const ITEM: MyWorkItem = {
  provider: "gitlab",
  host: "git.ringcentral.com",
  repoFullName: "jorm/jorm-lib",
  repoOwner: "jorm",
  repoName: "jorm-lib",
  number: 61,
  title: "Review an existing local checkout",
  isPullRequest: true,
  isDraft: false,
  updatedAt: "2026-11-17T01:00:00Z",
  url: "https://git.ringcentral.com/jorm/jorm-lib/-/merge_requests/61",
};
const ORIGIN: RepoOrigin = {
  host: ITEM.host,
  authority: ITEM.host,
  path: ITEM.repoFullName,
  provider: ITEM.provider,
};
const OTHER: RecentRepo = {
  path: `${PARENT}/ai-rules`,
  name: "ai-rules",
  owner: "tools",
  repoName: "ai-rules",
  host: ITEM.host,
  provider: "gitlab",
  lastOpenedAt: "2026-11-17T01:00:00Z",
};
let settings: AppSettings;
let calls: { command: string; args?: Record<string, unknown> }[];
let registered: RecentRepo[];
let directories: Set<string>;
let checkouts: Map<string, RepoOrigin>;
let validationWait: Promise<RepoInfo> | null;
let originWait: Promise<RepoOrigin> | null;
let previousTransport: ReturnType<typeof getTransport>;
const clients: QueryClient[] = [];
const originalScrollTo = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollTo",
);

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toastError: vi.fn() }));
vi.mock("@/lib/repo-lens/queries", async (original) => ({
  ...(await original<typeof import("@/lib/repo-lens/queries")>()),
  applyRepoLens: vi.fn(),
}));
vi.mock("@/features/repository/useOpenRepoByPath", async () => {
  const ui = await import("@/lib/stores/ui");
  return {
    claimRepoOpen: ui.claimRepoOpen,
    useOpenRecordedRepo: () => async (info: RepoInfo) =>
      ui.useUiStore.getState().openRepo(info),
  };
});
vi.mock("@/lib/settings/queries", async (original) => ({
  ...(await original<typeof import("@/lib/settings/queries")>()),
  useSettings: () => ({ data: settings, isPending: false }),
  useAddRecentRepo: () => ({
    mutateAsync: async (repo: RecentRepo) => {
      registered.push(repo);
      settings = {
        ...settings,
        recentRepos: [
          repo,
          ...settings.recentRepos.filter((r) => r.path !== repo.path),
        ],
      };
      return settings;
    },
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  previousTransport = getTransport();
  // The real virtualizer reads clientWidth/clientHeight; jsdom has no layout.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  Object.defineProperty(Element.prototype, "scrollTo", {
    configurable: true,
    value: () => undefined,
  });
  settings = { ...structuredClone(DEFAULT_SETTINGS), recentRepos: [OTHER] };
  calls = [];
  registered = [];
  directories = new Set([ROOT]);
  checkouts = new Map([[ROOT, ORIGIN]]);
  validationWait = null;
  originWait = null;
  useUiStore.setState(useUiStore.getInitialState(), true);
  installTransport({
    invoke: async <T,>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      calls.push({ command, args });
      if (command === "gitlab_work_hosts") return [ITEM.host] as T;
      if (command === "gitlab_work_accounts")
        return [{ host: ITEM.host, login: "reviewer" }] as T;
      if (command === "gitlab_work_items")
        return { items: [ITEM], truncated: false } as T;
      if (command === "gitlab_work_todos")
        return { items: [], truncated: false } as T;
      if (command === "path_is_dir")
        return directories.has(String(args?.path)) as T;
      if (command === "validate_repo") {
        const path = String(args?.path);
        if (path === ROOT && validationWait) return (await validationWait) as T;
        if (checkouts.has(path))
          return { root: path, name: path.split("/").at(-1) } as T;
        throw { kind: "notARepo", message: `not a git repository: ${path}` };
      }
      if (command === "repo_origin_path") {
        if (String(args?.repoPath) === ROOT && originWait)
          return (await originWait) as T;
        return (checkouts.get(String(args?.repoPath)) ?? {
          host: "",
          authority: "",
          path: "",
          provider: "",
        }) as T;
      }
      if (command === "git_worktree_list_user") return [] as T;
      if (command === "forge_clone") return ROOT as T;
      throw new Error(`Unexpected command: ${command}`);
    },
  });
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  installTransport(previousTransport);
  vi.restoreAllMocks();
  if (originalScrollTo)
    Object.defineProperty(Element.prototype, "scrollTo", originalScrollTo);
  else Reflect.deleteProperty(Element.prototype, "scrollTo");
});

function show(content: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>{content}</QueryClientProvider>,
  );
}

function cloneDialog(
  connected: (info: RepoInfo, stillValid: () => boolean) => Promise<void>,
  reuse = true,
) {
  return show(
    <CloneRepoDialog
      open
      onOpenChange={() => undefined}
      target={{
        provider: ITEM.provider,
        cloneUrl: `https://${ITEM.host}/${ITEM.repoFullName}.git`,
        name: ITEM.repoName,
      }}
      reuseFor={reuse ? ITEM : undefined}
      onCloned={connected}
    />,
  );
}

async function submitClone() {
  fireEvent.change(await screen.findByRole("textbox", { name: "Local path" }), {
    target: { value: PARENT },
  });
  fireEvent.click(screen.getByRole("button", { name: /^Clone$/ }));
}

describe("My works existing checkout discovery", () => {
  it.each(["missing", "unclassified", "stale"] as const)(
    "opens the existing default clone target when recent metadata is %s",
    async (classification) => {
      if (classification !== "missing")
        settings.recentRepos = [
          {
            path: ROOT,
            name: ITEM.repoName,
            lastOpenedAt: OTHER.lastOpenedAt,
            ...(classification === "stale"
              ? {
                  host: "old.test",
                  provider: "github",
                  owner: "old",
                  repoName: "renamed",
                }
              : {}),
          },
        ];
      show(<MyWorkScreen />);

      fireEvent.click(await screen.findByText(ITEM.title));

      await waitFor(() =>
        expect(useUiStore.getState().selectedPr).toEqual({
          kind: "remote",
          id: String(ITEM.number),
        }),
      );
      expect(useUiStore.getState().repoPath).toBe(ROOT);
      expect(
        useUiStore.getState().workDocuments.documents[0].repoFullName,
      ).toBe(ITEM.repoFullName);
      expect(registered).toEqual([
        expect.objectContaining({
          path: ROOT,
          host: ITEM.host,
          provider: ITEM.provider,
          owner: ITEM.repoOwner,
          repoName: ITEM.repoName,
        }),
      ]);
      expect(calls.some((call) => call.command === "forge_clone")).toBe(false);
      expect(screen.queryByText("Connect a local repository")).toBeNull();
    },
  );

  it("does not navigate when proof finishes after a newer Settings navigation", async () => {
    const pending = deferred<RepoInfo>();
    validationWait = pending.promise;
    show(<MyWorkScreen />);
    fireEvent.click(await screen.findByText(ITEM.title));
    await waitFor(() =>
      expect(calls.some((call) => call.command === "validate_repo")).toBe(true),
    );

    act(() => useUiStore.getState().openSettings());
    await act(async () => pending.resolve({ root: ROOT, name: ITEM.repoName }));

    expect(useUiStore.getState().view).toBe("settings");
    expect(useUiStore.getState().workDocuments.documents).toHaveLength(0);
    expect(registered).toEqual([]);
  });
});

describe("explicit MR clone destination", () => {
  it("reuses a verified existing checkout without attempting a clone", async () => {
    const connected = vi.fn(async () => undefined);
    cloneDialog(connected);

    await submitClone();

    await waitFor(() =>
      expect(connected).toHaveBeenCalledWith(
        { root: ROOT, name: ITEM.repoName },
        expect.any(Function),
      ),
    );
    expect(calls.some((call) => call.command === "repo_origin_path")).toBe(
      true,
    );
    expect(calls.some((call) => call.command === "forge_clone")).toBe(false);
  });

  it.each([
    { host: "other.test" },
    { authority: `${ITEM.host}:8443` },
    { path: "another/jorm-lib" },
    { provider: "github" },
    { authority: "" },
  ])(
    "refuses an occupied checkout with an unproven identity: %j",
    async (mismatch) => {
      checkouts.set(ROOT, { ...ORIGIN, ...mismatch });
      const connected = vi.fn(async () => undefined);
      cloneDialog(connected);

      await submitClone();

      await waitFor(() => expect(toastError).toHaveBeenCalled());
      expect(calls.some((call) => call.command === "forge_clone")).toBe(false);
      expect(connected).not.toHaveBeenCalled();
      expect(registered).toEqual([]);
      expect(toastError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringMatching(/already exists.*choose/i),
        }),
      );
    },
  );

  it("leaves an existing non-repository directory untouched", async () => {
    checkouts.delete(ROOT);
    const connected = vi.fn(async () => undefined);
    cloneDialog(connected);

    await submitClone();

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(calls.some((call) => call.command === "forge_clone")).toBe(false);
    expect(connected).not.toHaveBeenCalled();
    expect(directories.has(ROOT)).toBe(true);
  });

  it("refuses a nested directory that validates as its enclosing checkout", async () => {
    validationWait = Promise.resolve({
      root: PARENT,
      name: "ai-worker-review",
    });
    checkouts.set(PARENT, ORIGIN);
    const connected = vi.fn(async () => undefined);
    cloneDialog(connected);

    await submitClone();

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(calls.some((call) => call.command === "forge_clone")).toBe(false);
    expect(connected).not.toHaveBeenCalled();
    expect(registered).toEqual([]);
  });

  it("does not reopen a canceled MR when existing-checkout proof finishes late", async () => {
    const pending = deferred<RepoOrigin>();
    originWait = pending.promise;
    const connected = vi.fn(async () => undefined);
    const host = cloneDialog(connected);
    await submitClone();
    await waitFor(() =>
      expect(calls.some((call) => call.command === "repo_origin_path")).toBe(
        true,
      ),
    );

    host.unmount();
    await act(async () => pending.resolve(ORIGIN));

    expect(calls.some((call) => call.command === "forge_clone")).toBe(false);
    expect(connected).not.toHaveBeenCalled();
  });

  it("preserves generic targeted-clone behavior without an explicit MR identity", async () => {
    const connected = vi.fn(async () => undefined);
    cloneDialog(connected, false);

    await submitClone();

    await waitFor(() => expect(connected).toHaveBeenCalled());
    expect(calls.some((call) => call.command === "forge_clone")).toBe(true);
    expect(calls.some((call) => call.command === "path_is_dir")).toBe(false);
  });
});

it("retires a manually picked checkout when its Connect dialog unmounts", async () => {
  const pending = deferred<RepoInfo>();
  validationWait = pending.promise;
  vi.mocked(openDirectory).mockResolvedValue(ROOT);
  const connected = vi.fn(async () => undefined);
  const host = show(
    <ConnectWorkRepoDialog
      item={ITEM}
      onClose={() => undefined}
      onConnected={connected}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Choose local repository" }),
  );
  await waitFor(() =>
    expect(calls.some((call) => call.command === "validate_repo")).toBe(true),
  );

  host.unmount();
  await act(async () => pending.resolve({ root: ROOT, name: ITEM.repoName }));

  expect(connected).not.toHaveBeenCalled();
  expect(registered).toEqual([]);
});

it("requires the full web authority before connecting a manually picked checkout", async () => {
  checkouts.set(ROOT, { ...ORIGIN, authority: `${ITEM.host}:8443` });
  vi.mocked(openDirectory).mockResolvedValue(ROOT);
  const connected = vi.fn(async () => undefined);
  show(
    <ConnectWorkRepoDialog
      item={ITEM}
      onClose={() => undefined}
      onConnected={connected}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Choose local repository" }),
  );

  await waitFor(() => expect(toastError).toHaveBeenCalled());

  expect(connected).not.toHaveBeenCalled();
  expect(registered).toEqual([]);
});
