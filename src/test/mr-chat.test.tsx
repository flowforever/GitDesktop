import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifiedMrSelection } from "@/features/pulls/mr-chat/attachments";
import {
  type MrChatContext,
  parseMrChatIdentity,
  readMrCodeSelection,
} from "@/features/pulls/mr-chat/context";
import { MrChatPane } from "@/features/pulls/mr-chat/MrChatPane";
import { MrChatSidebar } from "@/features/pulls/mr-chat/MrChatSidebar";
import {
  type MrChatSession,
  useMrChatStore,
} from "@/features/pulls/mr-chat/store";
import type { AgentKind, AgentSessionArgs } from "@/lib/ai/agent";
import type { PrSnapshotComparison } from "@/lib/git/api/pr-snapshot";
import { prSnapshotComparisonOptions } from "@/lib/git/queries/pr-snapshot";
import type { AppSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { useDiffLayoutStore } from "@/lib/stores/diff-layout";

const external = vi.hoisted(() => ({
  run: vi.fn(),
  cancel: vi.fn(),
  snapshot: vi.fn(),
  load: vi.fn(),
  save: vi.fn(),
  filter: vi.fn(),
}));
vi.mock("@/lib/ai/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/agent")>()),
  runAgentSession: external.run,
  cancelAgentSession: external.cancel,
}));
vi.mock("@/lib/git/api/pr-snapshot", () => ({
  gitPrSnapshotFile: external.snapshot,
}));
vi.mock("@/features/pulls/mr-chat/persistence", () => ({
  loadMrChats: external.load,
  saveMrChats: external.save,
}));
vi.mock("@/lib/ai/ignore", () => ({
  aiExcludePatterns: async () => [],
  filterDiffByAiIgnore: external.filter,
  filterPathsByAiIgnore: async ({ paths }: { paths: { path: string }[] }) => ({
    paths: paths.map((entry) => entry.path),
    excluded: 0,
    unreadable: 0,
  }),
  lossyListingRows: (paths: string[]) =>
    paths.map((path) => ({ path, undecodable: false })),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: async () => DEFAULT_SETTINGS,
}));

const HEAD = "a".repeat(40);
const context: MrChatContext = {
  mr: { host: "git.example.com", repoFullName: "team/project", number: 7 },
  repoPath: "/repos/project",
  url: "https://git.example.com/team/project/-/merge_requests/7",
  title: "Avoid stale cache",
  body: "Refresh the cached value after a write.",
  baseRefName: "master",
  headRefName: "fix/cache",
  headSha: HEAD,
  files: [{ path: "src/cache.ts" }],
  diff: "diff --git a/src/cache.ts b/src/cache.ts\n@@ -1 +1 @@\n-old()\n+fresh()\n",
};
const bytes = (text: string) => ({
  base64: btoa(text),
  mime: null,
  tooLarge: false,
  size: text.length,
});
const comparison: PrSnapshotComparison = {
  baseSha: "b".repeat(40),
  headSha: HEAD,
  oldPath: "src/cache.ts",
  newPath: "src/cache.ts",
  before: bytes("oldValue()\n"),
  after: bytes("nextValue()\n"),
  patch:
    "diff --git a/src/cache.ts b/src/cache.ts\n--- a/src/cache.ts\n+++ b/src/cache.ts\n@@ -1 +1 @@\n-oldValue()\n+nextValue()\n",
};

function savedSession(
  id: string,
  overrides: Partial<MrChatSession> = {},
): MrChatSession {
  return {
    id,
    mr: context.mr,
    repoPath: context.repoPath,
    agent: "codex",
    model: "",
    effort: "",
    nativeSessionId: null,
    state: "active",
    running: false,
    turns: [
      {
        prompt: id,
        narration: `${id} answer`,
        status: "done",
        statusText: "",
        segments: [],
        commitHash: null,
        costUsd: null,
        error: null,
      },
    ],
    ...overrides,
  };
}

const clients: QueryClient[] = [];
const codeHosts: HTMLElement[] = [];
beforeEach(() => {
  useDiffLayoutStore.setState(useDiffLayoutStore.getInitialState());
  external.run
    .mockReset()
    .mockImplementation(async (args: AgentSessionArgs) => {
      args.onEvent({ kind: "nativeSession", id: `native-${args.sessionId}` });
      args.onEvent({
        kind: "done",
        text: "The cache is now refreshed.",
        isError: false,
        costUsd: null,
      });
      return null;
    });
  external.cancel.mockReset().mockResolvedValue(undefined);
  external.snapshot.mockReset().mockResolvedValue({
    base64: btoa("export const fresh = true;\n"),
    mime: null,
    tooLarge: false,
    size: 27,
  });
  external.load.mockReset().mockResolvedValue([]);
  external.save.mockReset().mockResolvedValue(undefined);
  external.filter
    .mockReset()
    .mockImplementation(
      async ({ text, files }: { text: string; files: { path: string }[] }) => ({
        text,
        files,
        excludedFiles: 0,
        unreadableFiles: 0,
        unkeyableSections: 0,
      }),
    );
  useMrChatStore.setState({ sessions: [], hydrated: true });
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  for (const host of codeHosts.splice(0)) host.remove();
  document.getSelection()?.removeAllRanges();
});

function mountSidebar(
  current = context,
  collapsible = false,
  preferences: Partial<AppSettings> = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, {
    ...DEFAULT_SETTINGS,
    defaultAgent: "codex",
    ...preferences,
  });
  for (const agent of [
    "claude",
    "codex",
    "copilot",
    "opencode",
  ] satisfies AgentKind[])
    client.setQueryData(["agent-models", agent], { models: [], live: false });
  clients.push(client);
  const host = document.createElement("div");
  codeHosts.push(host);
  document.body.append(host);
  const chat = (value: MrChatContext, onCollapse?: () => void) => (
    <MrChatSidebar
      context={value}
      lens="origin"
      codeHostRef={{ current: host }}
      enabled
      onCollapse={onCollapse}
    />
  );
  const ui = (value: MrChatContext) => (
    <QueryClientProvider client={client}>
      {collapsible ? (
        <MrChatPane>{({ onCollapse }) => chat(value, onCollapse)}</MrChatPane>
      ) : (
        chat(value)
      )}
    </QueryClientProvider>
  );
  const result = render(ui(current));
  return {
    ...result,
    host,
    client,
    rerenderContext: (value: MrChatContext) => result.rerender(ui(value)),
  };
}

describe("MR chat scope", () => {
  it("retains the actual chat's draft, attachments, and session after collapsing", async () => {
    useMrChatStore.setState({ sessions: [savedSession("collapse-retention")] });
    const user = userEvent.setup();
    const sidebar = mountSidebar(context, true);
    sidebar.client.setQueryData(
      prSnapshotComparisonOptions(
        context.repoPath,
        7,
        HEAD,
        "src/cache.ts",
        "origin",
      ).queryKey,
      comparison,
    );
    act(() => {
      sidebar.host.innerHTML = `<div data-diff-file-path="src/cache.ts" data-diff-head-sha="${HEAD}"></div>`;
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Attach current file" }),
      ).not.toHaveAttribute("aria-disabled", "true"),
    );
    await user.click(
      screen.getByRole("button", { name: "Attach current file" }),
    );
    await screen.findByRole("button", { name: "Remove src/cache.ts" });
    const editor = screen.getByRole("textbox", {
      name: "Message about this MR",
    });
    await user.type(editor, "Keep the attachment and draft");
    await user.click(screen.getByRole("button", { name: "Collapse MR chat" }));
    expect(
      screen.queryByRole("textbox", { name: "Message about this MR" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Expand MR chat" }));
    expect(screen.getByRole("textbox", { name: "Message about this MR" })).toBe(
      editor,
    );
    expect(editor).toHaveValue("Keep the attachment and draft");
    expect(
      screen.getByRole("button", { name: "Remove src/cache.ts" }),
    ).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "Ongoing MR chats" }),
    ).toHaveTextContent("collapse-retention");
    expect(external.cancel).not.toHaveBeenCalled();
  });

  it("retires a pending attachment read on collapse and permits another after expanding", async () => {
    let finish!: (value: ReturnType<typeof bytes>) => void;
    external.snapshot.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const user = userEvent.setup();
    const sidebar = mountSidebar(context, true);
    act(() => {
      sidebar.host.innerHTML = `<div data-diff-file-path="src/pending.ts" data-diff-head-sha="${HEAD}"></div>`;
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Attach current file" }),
      ).not.toHaveAttribute("aria-disabled", "true"),
    );
    await user.click(
      screen.getByRole("button", { name: "Attach current file" }),
    );
    await waitFor(() => expect(external.snapshot).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: "Collapse MR chat" }));
    await act(async () => {
      finish(bytes("pending source\n"));
    });
    await user.click(screen.getByRole("button", { name: "Expand MR chat" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Attach current file" }),
      ).not.toHaveAttribute("aria-disabled", "true"),
    );
    expect(
      screen.queryByRole("button", { name: "Remove src/pending.ts" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Attach current file" }),
    );
    await screen.findByRole("button", { name: "Remove src/pending.ts" });
  });

  it("uses host, full nested project, and IID from the canonical URL", () => {
    expect(
      parseMrChatIdentity(
        "https://Git.Example.com/group/team/project/-/merge_requests/7?view=diff",
        7,
      ),
    ).toEqual({
      host: "git.example.com",
      repoFullName: "group/team/project",
      number: 7,
    });
    expect(parseMrChatIdentity(context.url, 8)).toBeNull();
    expect(
      parseMrChatIdentity("file:///team/project/-/merge_requests/7", 7),
    ).toBeNull();
  });

  it("shows only ongoing sessions belonging to this exact MR and repository", async () => {
    useMrChatStore.setState({
      sessions: [
        savedSession("Current waiting chat"),
        savedSession("Other MR", { mr: { ...context.mr, number: 8 } }),
        savedSession("Other project", {
          mr: { ...context.mr, repoFullName: "other/project" },
        }),
        savedSession("Other host", {
          mr: { ...context.mr, host: "elsewhere.example.com" },
        }),
        savedSession("Other checkout", { repoPath: "/repos/other" }),
        savedSession("Completed chat", { state: "completed" }),
      ],
    });
    const user = userEvent.setup();
    mountSidebar();
    await user.click(
      screen.getByRole("combobox", { name: "Ongoing MR chats" }),
    );
    expect(
      await screen.findByRole("option", { name: /Current waiting chat/ }),
    ).toBeInTheDocument();
    for (const name of [
      "Other MR",
      "Other project",
      "Other host",
      "Other checkout",
      "Completed chat",
    ])
      expect(
        screen.queryByRole("option", { name: new RegExp(name) }),
      ).not.toBeInTheDocument();
  });

  it("sends the current MR context through a read-only CLI conversation and resumes its native id", async () => {
    const user = userEvent.setup();
    mountSidebar();
    await user.type(
      screen.getByRole("textbox", { name: "Message about this MR" }),
      "Why is this safe?",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("The cache is now refreshed.");
    const first = external.run.mock.calls[0][0] as AgentSessionArgs;
    expect(first).toMatchObject({
      agent: "codex",
      readOnly: true,
      resume: false,
      worktreePath: context.repoPath,
    });
    for (const value of [
      context.url,
      context.title,
      context.body,
      HEAD,
      "fresh()",
      "Why is this safe?",
    ])
      expect(first.userPrompt).toContain(value);
    await user.type(
      screen.getByRole("textbox", { name: "Message about this MR" }),
      "Explain the tests",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(external.run).toHaveBeenCalledTimes(2));
    expect(external.run.mock.calls[1][0]).toMatchObject({
      resume: true,
      sessionId: first.sessionId,
      nativeSessionId: `native-${first.sessionId}`,
    });
  });

  it("waits for cold MR diff context before launching the CLI", async () => {
    let loaded!: (value: string) => void;
    const diff = new Promise<string>((resolve) => {
      loaded = resolve;
    });
    const user = userEvent.setup();
    mountSidebar({ ...context, diff: undefined, loadDiff: () => diff });
    await user.type(
      screen.getByRole("textbox", { name: "Message about this MR" }),
      "Explain the patch",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(external.run).not.toHaveBeenCalled();
    expect(screen.getByText("Preparing MR context…")).toBeInTheDocument();
    await act(async () => {
      loaded("+loadedExactPatch()");
    });
    await waitFor(() => expect(external.run).toHaveBeenCalledTimes(1));
    expect(
      (external.run.mock.calls[0][0] as AgentSessionArgs).userPrompt,
    ).toContain("loadedExactPatch()");
  });

  it("switches MRs without carrying the prior draft, attachments, transcript, or native session", async () => {
    const user = userEvent.setup();
    const sidebar = mountSidebar();
    await user.type(
      screen.getByRole("textbox", { name: "Message about this MR" }),
      "First MR question",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("The cache is now refreshed.");
    const first = external.run.mock.calls[0][0] as AgentSessionArgs;
    await user.type(
      screen.getByRole("textbox", { name: "Message about this MR" }),
      "Unsent first MR draft",
    );
    const next = {
      ...context,
      mr: { ...context.mr, number: 8 },
      url: context.url.replace(/7$/, "8"),
      title: "Second MR",
      body: "Second description",
      diff: "+second()",
    };
    sidebar.rerenderContext(next);
    expect(
      screen.getByRole("textbox", { name: "Message about this MR" }),
    ).toHaveValue("");
    expect(
      screen.queryByText("The cache is now refreshed."),
    ).not.toBeInTheDocument();
    await user.type(
      screen.getByRole("textbox", { name: "Message about this MR" }),
      "Second MR question",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(external.run).toHaveBeenCalledTimes(2));
    const second = external.run.mock.calls[1][0] as AgentSessionArgs;
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second).toMatchObject({ nativeSessionId: null, resume: false });
    expect(second.userPrompt).toContain(next.url);
    expect(second.userPrompt).not.toContain(context.url);
    expect(second.userPrompt).not.toContain("Unsent first MR draft");
  });

  it("refuses a follow-up that names another MR even when the session id is valid", () => {
    const id = useMrChatStore
      .getState()
      .start(context, "One", "codex", "", "", []);
    external.run.mockClear();
    useMrChatStore
      .getState()
      .send(
        id,
        { ...context, mr: { ...context.mr, number: 9 } },
        "Wrong scope",
        [],
      );
    expect(external.run).not.toHaveBeenCalled();
  });

  it("removes AI-excluded MR content before it reaches the CLI", async () => {
    external.filter.mockResolvedValue({
      text: "+public()",
      files: [{ path: "src/public.ts" }],
      excludedFiles: 1,
      unreadableFiles: 0,
      unkeyableSections: 0,
    });
    const user = userEvent.setup();
    mountSidebar({
      ...context,
      diff: "+private-secret()",
      files: [{ path: "secrets.env" }],
    });
    await user.type(
      screen.getByRole("textbox", { name: "Message about this MR" }),
      "Explain this",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(external.run).toHaveBeenCalledTimes(1));
    const request = external.run.mock.calls[0][0] as AgentSessionArgs;
    expect(request.userPrompt).toContain("public()");
    expect(request.userPrompt).not.toContain("private-secret");
    expect(request.userPrompt).not.toContain("secrets.env");
  });

  it("keeps the active conversation available without an End chat control", () => {
    useMrChatStore.setState({
      sessions: [savedSession("Current conversation")],
    });
    mountSidebar();
    expect(
      screen.queryByRole("button", { name: "End chat" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Current conversation answer")).toBeInTheDocument();
    expect(useMrChatStore.getState().sessions[0].state).toBe("active");
  });

  it("keeps an in-flight response scoped to its MR while another MR is visible", async () => {
    let first!: AgentSessionArgs;
    let finish!: () => void;
    external.run.mockImplementation((args: AgentSessionArgs) => {
      first = args;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const user = userEvent.setup();
    const sidebar = mountSidebar();
    await user.type(
      screen.getByRole("textbox", { name: "Message about this MR" }),
      "Keep working",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(external.run).toHaveBeenCalledTimes(1));
    sidebar.rerenderContext({
      ...context,
      mr: { ...context.mr, number: 8 },
      url: context.url.replace(/7$/, "8"),
    });
    await act(async () => {
      first.onEvent({
        kind: "done",
        text: "First MR result",
        isError: false,
        costUsd: null,
      });
      finish();
    });
    expect(screen.queryByText("First MR result")).not.toBeInTheDocument();
    expect(external.cancel).not.toHaveBeenCalled();
    sidebar.rerenderContext(context);
    await screen.findByText("First MR result");
  });

  it("stops context preparation locally without cancelling an unlaunched CLI session", async () => {
    let loaded!: (value: string) => void;
    const diff = new Promise<string>((resolve) => {
      loaded = resolve;
    });
    const user = userEvent.setup();
    mountSidebar({ ...context, diff: undefined, loadDiff: () => diff });
    const editor = screen.getByRole("textbox", {
      name: "Message about this MR",
    });
    await user.type(editor, "Prepare context");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(external.run).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Stop response" }));
    expect(external.cancel).not.toHaveBeenCalled();
    await act(async () => {
      loaded("+preparedPatch()");
    });
    expect(external.run).not.toHaveBeenCalled();
    await screen.findByText("Cancelled.");
    const replyEditor = screen.getByRole("textbox", {
      name: "Message about this MR",
    });
    await user.type(replyEditor, "Send the next question");
    expect(replyEditor).toHaveValue("Send the next question");
    expect(
      screen.getByRole("button", { name: "Send message" }),
    ).not.toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(external.run).toHaveBeenCalledTimes(1));
    expect(external.run.mock.calls[0][0]).toMatchObject({ resume: false });
  });

  it("holds another turn until the cancelled CLI transport settles after the cancellation signal", async () => {
    let running!: AgentSessionArgs;
    let settled!: () => void;
    external.run.mockImplementation((args: AgentSessionArgs) => {
      running = args;
      return new Promise<void>((resolve) => {
        settled = resolve;
      });
    });
    const user = userEvent.setup();
    mountSidebar();
    const editor = screen.getByRole("textbox", {
      name: "Message about this MR",
    });
    await user.type(editor, "Start a response");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(external.run).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Stop response" }));
    const replyEditor = screen.getByRole("textbox", {
      name: "Message about this MR",
    });
    await user.type(replyEditor, "Next question{Enter}");
    expect(replyEditor).toHaveValue("Next question");
    expect(external.run).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Stop response" }),
    ).toBeInTheDocument();
    act(() =>
      running.onEvent({
        kind: "done",
        text: "Late cancelled output",
        isError: false,
        costUsd: null,
      }),
    );
    expect(screen.queryByText("Late cancelled output")).not.toBeInTheDocument();
    await act(async () => {
      settled();
    });
    await screen.findByText("Cancelled.");
    expect(
      screen.getByRole("button", { name: "Send message" }),
    ).not.toHaveAttribute("aria-disabled", "true");
  });
});

describe("MR chat harness defaults", () => {
  const preferences: Partial<AppSettings> = {
    defaultAgent: "codex",
    agentDefaults: {
      codex: { model: "configured-codex", effort: "high" },
      claude: { model: "configured-claude", effort: "medium" },
    },
  };

  async function send(user: ReturnType<typeof userEvent.setup>) {
    await user.type(
      screen.getByRole("textbox", { name: "Message about this MR" }),
      "Explain this MR",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(external.run).toHaveBeenCalledTimes(1));
  }

  async function chooseEffort(
    user: ReturnType<typeof userEvent.setup>,
    label: string,
  ) {
    await user.click(
      screen.getByRole("combobox", { name: "Reasoning effort" }),
    );
    await user.click(await screen.findByRole("option", { name: label }));
  }

  it("starts a new MR conversation with the configured model and thinking effort", async () => {
    const user = userEvent.setup();
    mountSidebar(context, false, preferences);
    expect(screen.getByRole("combobox", { name: "Agent model" })).toHaveValue(
      "configured-codex",
    );
    await send(user);
    expect(external.run.mock.calls[0][0]).toMatchObject({
      agent: "codex",
      model: "configured-codex",
      effort: "high",
    });
  });

  it("derives fresh settings while a new MR conversation has no explicit overrides", async () => {
    const user = userEvent.setup();
    const sidebar = mountSidebar(context, false, preferences);
    act(() =>
      sidebar.client.setQueryData(settingsKeys.settings, {
        ...DEFAULT_SETTINGS,
        ...preferences,
        agentDefaults: {
          ...preferences.agentDefaults,
          codex: { model: "updated-codex", effort: "xhigh" },
        },
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Agent model" })).toHaveValue(
        "updated-codex",
      ),
    );
    await send(user);
    expect(external.run.mock.calls[0][0]).toMatchObject({
      model: "updated-codex",
      effort: "xhigh",
    });
  });

  it("preserves explicit native-default blanks when MR settings change", async () => {
    const user = userEvent.setup();
    const sidebar = mountSidebar(context, false, preferences);
    const model = screen.getByRole("combobox", { name: "Agent model" });
    expect(model).toHaveValue("configured-codex");
    await user.clear(model);
    await user.keyboard("{Escape}");
    await chooseEffort(user, "Default");
    act(() =>
      sidebar.client.setQueryData(settingsKeys.settings, {
        ...DEFAULT_SETTINGS,
        ...preferences,
        agentDefaults: {
          ...preferences.agentDefaults,
          codex: { model: "updated-codex", effort: "xhigh" },
        },
      }),
    );
    await send(user);
    expect(external.run.mock.calls[0][0]).toMatchObject({
      model: "",
      effort: "",
    });
  });

  it("uses the next harness defaults without carrying the prior model or effort pick", async () => {
    const user = userEvent.setup();
    mountSidebar(context, false, preferences);
    const model = screen.getByRole("combobox", { name: "Agent model" });
    await user.clear(model);
    await user.type(model, "manual-codex");
    await user.keyboard("{Escape}");
    await chooseEffort(user, "Low");
    await user.click(screen.getByRole("combobox", { name: "Agent" }));
    await user.click(await screen.findByRole("option", { name: "Claude" }));
    await waitFor(() => expect(model).toHaveValue("configured-claude"));
    await send(user);
    expect(external.run.mock.calls[0][0]).toMatchObject({
      agent: "claude",
      model: "configured-claude",
      effort: "medium",
    });
  });

  it.each([
    { model: "saved-session-model", effort: "low" },
    { model: "", effort: "" },
  ])("keeps an existing MR session's saved picks %j", async (saved) => {
    useMrChatStore.setState({
      sessions: [savedSession("existing-defaults", saved)],
    });
    const user = userEvent.setup();
    mountSidebar(context, false, { ...preferences, defaultAgent: "claude" });
    expect(screen.getByRole("combobox", { name: "Agent model" })).toHaveValue(
      saved.model,
    );
    await send(user);
    expect(external.run.mock.calls[0][0]).toMatchObject({
      agent: "codex",
      model: saved.model,
      effort: saved.effort,
    });
  });
});

describe("MR code attachments", () => {
  it("attaches the actually painted file at the MR head and lets the user remove it", async () => {
    const user = userEvent.setup();
    const { host } = mountSidebar();
    act(() => {
      host.innerHTML = `<div data-diff-file-path="src/painted.ts" data-diff-head-sha="${HEAD}"><pre class="gd-code">painted()</pre></div>`;
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Attach current file" }),
      ).toBeEnabled(),
    );
    await user.click(
      screen.getByRole("button", { name: "Attach current file" }),
    );
    expect(external.snapshot).toHaveBeenCalledWith(
      context.repoPath,
      HEAD,
      "src/painted.ts",
      "origin",
    );
    await screen.findByRole("button", { name: "Remove src/painted.ts" });
    await user.click(
      screen.getByRole("button", { name: "Remove src/painted.ts" }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Message about this MR" }),
      "No attachment",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(
      (external.run.mock.calls[0][0] as AgentSessionArgs).userPrompt,
    ).not.toContain("export const fresh = true;");
  });

  it("reuses the pinned before bytes of a deleted file without reading the checkout or a new head file", async () => {
    const deleted = {
      ...comparison,
      newPath: null,
      after: null,
      patch:
        "diff --git a/src/cache.ts b/src/cache.ts\n--- a/src/cache.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-oldValue()\n",
    };
    const user = userEvent.setup();
    const sidebar = mountSidebar();
    sidebar.client.setQueryData(
      prSnapshotComparisonOptions(
        context.repoPath,
        7,
        HEAD,
        "src/cache.ts",
        "origin",
      ).queryKey,
      deleted,
    );
    act(() => {
      sidebar.host.innerHTML = `<div data-diff-file-path="src/cache.ts" data-diff-head-sha="${HEAD}"></div>`;
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Attach current file" }),
      ).toBeEnabled(),
    );
    await user.click(
      screen.getByRole("button", { name: "Attach current file" }),
    );
    await screen.findByRole("button", { name: "Remove src/cache.ts" });
    expect(external.snapshot).not.toHaveBeenCalled();
    await user.type(
      screen.getByRole("textbox", { name: "Message about this MR" }),
      "Why was this removed?",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(external.run).toHaveBeenCalledTimes(1));
    const prompt = (external.run.mock.calls[0][0] as AgentSessionArgs)
      .userPrompt;
    expect(prompt).toContain("oldValue()");
    expect(prompt).toContain(comparison.baseSha);
    expect(prompt).toContain("old side");
  });

  it("proves an old-side selection against its pinned line and rejects stale head or mismatched displayed text", () => {
    const selected = {
      id: "selected",
      kind: "selection" as const,
      path: "src/cache.ts",
      side: "old" as const,
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 8,
      text: "oldValue",
      format: "code" as const,
      headSha: HEAD,
    };
    expect(
      verifiedMrSelection(selected, comparison, HEAD, "src/cache.ts"),
    ).toMatchObject({
      revision: comparison.baseSha,
      text: "oldValue",
      side: "old",
    });
    expect(
      verifiedMrSelection(
        { ...selected, headSha: "c".repeat(40) },
        comparison,
        HEAD,
        "src/cache.ts",
      ),
    ).toBeNull();
    expect(
      verifiedMrSelection(
        { ...selected, text: "staleVal" },
        comparison,
        HEAD,
        "src/cache.ts",
      ),
    ).toBeNull();
    expect(
      verifiedMrSelection(
        { ...selected, startLine: 2, endLine: 2 },
        comparison,
        HEAD,
        "src/cache.ts",
      ),
    ).toBeNull();
  });

  it.each(["oldValue", "staleVal"])(
    "verifies the selected painted old-side %s before accepting its context chip",
    async (text) => {
      const user = userEvent.setup();
      const sidebar = mountSidebar();
      sidebar.client.setQueryData(
        prSnapshotComparisonOptions(
          context.repoPath,
          7,
          HEAD,
          "src/cache.ts",
          "origin",
        ).queryKey,
        comparison,
      );
      act(() => {
        sidebar.host.innerHTML = `<div data-diff-file-path="src/cache.ts" data-diff-head-sha="${HEAD}"><table><tbody><tr class="diff-line"><td data-line-old-num="1"></td><td class="diff-line-old-content"><div class="diff-line-content-raw"><span data-template>${text}()</span></div></td></tr></tbody></table></div>`;
        const node = sidebar.host.querySelector("[data-template]")?.firstChild;
        if (!node) throw new Error("Missing selected code fixture");
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, 8);
        const selection = document.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
      });
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Attach selected code" }),
        ).toBeEnabled(),
      );
      await user.click(
        screen.getByRole("button", { name: "Attach selected code" }),
      );
      if (text === "staleVal") {
        expect(
          screen.queryByRole("button", { name: "Remove src/cache.ts" }),
        ).not.toBeInTheDocument();
        expect(screen.getByRole("alert")).toHaveTextContent(
          "does not match the current MR snapshot",
        );
        return;
      }
      await screen.findByRole("button", { name: "Remove src/cache.ts" });
      await user.type(
        screen.getByRole("textbox", { name: "Message about this MR" }),
        "Explain the selected value",
      );
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => expect(external.run).toHaveBeenCalledTimes(1));
      const prompt = (external.run.mock.calls[0][0] as AgentSessionArgs)
        .userPrompt;
      expect(prompt).toContain("oldValue");
      expect(prompt).toContain("old side, lines 1–1");
      expect(prompt).toContain(comparison.baseSha);
    },
  );

  it("keeps a pending file read out of the next MR after navigation", async () => {
    let resolve!: (value: {
      base64: string;
      mime: null;
      tooLarge: boolean;
      size: number;
    }) => void;
    external.snapshot.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const user = userEvent.setup();
    const sidebar = mountSidebar();
    act(() => {
      sidebar.host.innerHTML = `<div data-diff-file-path="src/prior.ts" data-diff-head-sha="${HEAD}"><pre class="gd-code">old()</pre></div>`;
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Attach current file" }),
      ).toBeEnabled(),
    );
    await user.click(
      screen.getByRole("button", { name: "Attach current file" }),
    );
    sidebar.rerenderContext({
      ...context,
      mr: { ...context.mr, number: 8 },
      url: context.url.replace(/7$/, "8"),
    });
    await act(async () => {
      resolve({
        base64: btoa("prior secret"),
        mime: null,
        tooLarge: false,
        size: 12,
      });
    });
    expect(
      screen.queryByRole("button", { name: "Remove src/prior.ts" }),
    ).not.toBeInTheDocument();
  });

  it("captures only selected code with the painted file, side, and source line", () => {
    const host = document.createElement("div");
    host.innerHTML =
      '<div data-diff-file-path="src/old.ts"><table><tbody><tr class="diff-line"><td data-line-old-num="41"></td><td class="diff-line-old-content"><div class="diff-line-content-raw"><span data-template>oldValue()</span></div></td><td data-line-new-num="42"></td><td class="diff-line-new-content"><div class="diff-line-content-raw"><span data-template>nextValue()</span></div></td></tr></tbody></table></div>';
    document.body.append(host);
    const node = host.querySelector(
      ".diff-line-old-content [data-template]",
    )?.firstChild;
    if (!node) throw new Error("Missing fixture code");
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 8);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(readMrCodeSelection(host)).toMatchObject({
      path: "src/old.ts",
      side: "old",
      startLine: 41,
      endLine: 41,
      text: "oldValue",
    });
    const other = host.querySelector(
      ".diff-line-new-content [data-template]",
    )?.firstChild;
    if (!other) throw new Error("Missing other-side fixture");
    range.setEnd(other, 4);
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(readMrCodeSelection(host)).toBeNull();
    host.remove();
  });
});
