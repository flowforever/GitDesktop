import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MyWorkScreen } from "@/features/mywork/MyWorkScreen";
import { CloneRepoDialog } from "@/features/welcome/CloneRepoDialog";
import { useInvalidateAfterReconnect } from "@/lib/git/queries/accounts";
import { useGitLabWorkAccounts } from "@/lib/git/queries/gitlab-work";
import type { WorkTodo } from "@/lib/git/types/gitlab-work";
import { type AppSettings, DEFAULT_SETTINGS } from "@/lib/settings/api";
import { useUiStore } from "@/lib/stores/ui";
import { installTransport } from "@/lib/transport";

let settings: AppSettings;
let calls: { command: string; args: Record<string, unknown> | undefined }[];
let todos: WorkTodo[];
let failCompletion = false;
let cloneWait: Promise<string> | null = null;
let viewer = "first-user";
vi.mock("@/lib/settings/queries", async (original) => ({
  ...(await original<typeof import("@/lib/settings/queries")>()),
  useSettings: () => ({ data: settings, isPending: false }),
  useSaveSettingsPatch: () => ({
    isPending: false,
    mutateAsync: async (patch: Partial<AppSettings>) => {
      settings = { ...settings, ...patch };
      return settings;
    },
  }),
}));

beforeEach(() => {
  settings = { ...DEFAULT_SETTINGS, recentRepos: [], myWorkTeamLabels: [] };
  calls = [];
  failCompletion = false;
  cloneWait = null;
  viewer = "first-user";
  todos = ["git.one.test", "git.two.test"].map((host) => ({
    id: "9007199254740993",
    host,
    title: `Review ${host}`,
    action: "mentioned",
    targetType: "MergeRequest",
    url: `https://${host}/team/repo/-/merge_requests/7`,
    updatedAt: "2026-11-17T01:00:00Z",
    item: null,
  }));
  useUiStore.setState(useUiStore.getInitialState(), true);
  onlineManager.setOnline(true);
  installTransport({
    invoke: async <T,>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      calls.push({ command, args });
      if (command === "gitlab_work_hosts")
        return ["git.one.test", "git.two.test"] as T;
      if (command === "gitlab_work_accounts")
        return [{ host: "git.one.test", login: viewer }] as T;
      if (command === "forge_clone")
        return (cloneWait ? await cloneWait : "/repos/repo") as T;
      if (command === "validate_repo")
        return { root: "/repos/repo", name: "repo" } as T;
      if (command === "gitlab_work_items")
        return { items: [], truncated: false } as T;
      if (command === "gitlab_work_todos")
        return { items: [...todos], truncated: false } as T;
      if (command === "gitlab_work_todo_done") {
        if (failCompletion) throw new Error("Connection lost");
        todos = todos.filter(
          (todo) => todo.host !== args?.host || todo.id !== args?.id,
        );
        return undefined as T;
      }
      throw new Error(`Unexpected command: ${command}`);
    },
  });
});

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MyWorkScreen />
    </QueryClientProvider>,
  );
}

describe("GitLab work home", () => {
  it("clears fresh home pages when reconnecting without any repository status query", async () => {
    const client = new QueryClient();
    client.setQueryData(["gitlab-work", "mine", []], {
      items: [{ title: "Previous user's MR" }],
      truncated: false,
    });
    const hook = renderHook(() => useInvalidateAfterReconnect(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    await act(async () => hook.result.current());
    expect(client.getQueryData(["gitlab-work", "mine", []])).toBeUndefined();
  });

  it("detects a CLI account change independently and clears inactive personal pages", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const hook = renderHook(() => useGitLabWorkAccounts(true), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    await waitFor(() =>
      expect(hook.result.current.data?.[0]?.login).toBe("first-user"),
    );
    client.setQueryData(["gitlab-work", "authored", []], {
      items: [{ title: "Old account" }],
      truncated: false,
    });
    viewer = "second-user";
    await act(async () => {
      await hook.result.current.refetch();
    });
    await waitFor(() =>
      expect(
        client.getQueryData(["gitlab-work", "authored", []]),
      ).toBeUndefined(),
    );
  });
  it("does not reopen a canceled MR when an unmounted clone finishes later", async () => {
    let finish!: (path: string) => void;
    cloneWait = new Promise((resolve) => {
      finish = resolve;
    });
    const client = new QueryClient();
    const connected = vi.fn(async () => undefined);
    const shown = render(
      <QueryClientProvider client={client}>
        <CloneRepoDialog
          open
          onOpenChange={() => undefined}
          target={{
            provider: "gitlab",
            cloneUrl: "https://git.one.test/team/repo.git",
            name: "repo",
          }}
          onCloned={connected}
        />
      </QueryClientProvider>,
    );
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Local path" }),
      { target: { value: "/repos" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /^Clone$/ }));
    await waitFor(() =>
      expect(calls.some((call) => call.command === "forge_clone")).toBe(true),
    );
    shown.unmount();
    await act(async () => {
      finish("/repos/repo");
    });
    await waitFor(() =>
      expect(calls.some((call) => call.command === "validate_repo")).toBe(true),
    );
    expect(connected).not.toHaveBeenCalled();
  });
  it("seeds an MR clone and uses GitLab authentication before continuing to detail", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const connected = vi.fn(async () => undefined);
    render(
      <QueryClientProvider client={client}>
        <CloneRepoDialog
          open
          onOpenChange={() => undefined}
          target={{
            provider: "gitlab",
            cloneUrl: "https://git.one.test/team/repo.git",
            name: "repo",
          }}
          onCloned={connected}
        />
      </QueryClientProvider>,
    );
    expect(
      await screen.findByRole("textbox", {
        name: "Repository URL or owner/name",
      }),
    ).toHaveValue("https://git.one.test/team/repo.git");
    fireEvent.change(screen.getByRole("textbox", { name: "Local path" }), {
      target: { value: "/repos" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Clone$/ }));
    await waitFor(() =>
      expect(connected).toHaveBeenCalledWith(
        {
          root: "/repos/repo",
          name: "repo",
        },
        expect.any(Function),
      ),
    );
    expect(
      calls.find((call) => call.command === "forge_clone")?.args?.provider,
    ).toBe("gitlab");
    expect(calls.some((call) => call.command === "clone_repo")).toBe(false);
  });
  it("loads only the selected category and leaves the team query disabled until labels are configured", async () => {
    show();
    expect(
      screen.getByRole("tab", { name: /^My Merge Requests/ }),
    ).toHaveAttribute("aria-selected", "true");
    await screen.findByText("No open items in this category.");
    expect(
      calls
        .filter((call) => call.command === "gitlab_work_items")
        .map((call) => call.args?.section),
    ).toEqual(["mine"]);
    fireEvent.click(screen.getByRole("tab", { name: "Team Merge Requests" }));
    expect(
      await screen.findByText(
        "Configure your team labels to find matching merge requests.",
      ),
    ).toBeVisible();
    expect(
      calls.filter((call) => call.command === "gitlab_work_items"),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Configure labels" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Labels" }), {
      target: { value: "team-a\nteam-b" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save labels" }));
    await waitFor(() =>
      expect(calls.some((call) => call.args?.section === "team")).toBe(true),
    );
    expect(
      calls.find((call) => call.args?.section === "team")?.args?.labels,
    ).toEqual(["team-a", "team-b"]);
  });

  it("completes one host's Todo without removing another host's identically numbered Todo", async () => {
    show();
    fireEvent.click(screen.getByRole("tab", { name: "Todos" }));
    await screen.findByText("Review git.one.test");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Mark complete: Review git.one.test",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Review git.one.test")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Review git.two.test")).toBeVisible();
    expect(
      calls.find((call) => call.command === "gitlab_work_todo_done")?.args,
    ).toEqual({ host: "git.one.test", id: "9007199254740993" });
  });

  it("retains a Todo after completion fails", async () => {
    failCompletion = true;
    show();
    fireEvent.click(screen.getByRole("tab", { name: "Todos" }));
    await screen.findByText("Review git.one.test");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Mark complete: Review git.one.test",
      }),
    );
    await waitFor(() =>
      expect(
        calls.some((call) => call.command === "gitlab_work_todo_done"),
      ).toBe(true),
    );
    expect(screen.getByText("Review git.one.test")).toBeVisible();
  });
});
