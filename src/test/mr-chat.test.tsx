import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifiedMrSelection } from "@/features/pulls/mr-chat/attachments";
import {
  type MrChatContext,
  type MrChatSelectionRequest,
  mrChatKey,
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
import { useMrTextDraft } from "@/lib/pulls/mr-document-drafts";
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
  paths: vi.fn(),
  comparison: vi.fn(),
  settings: vi.fn(),
  openExternalFile: vi.fn(),
}));
vi.mock("@/features/sessions/useOpenFile", () => ({
  useOpenFile: () => external.openExternalFile,
}));
vi.mock("@/lib/ai/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/agent")>()),
  runAgentSession: external.run,
  cancelAgentSession: external.cancel,
}));
vi.mock("@/lib/git/api/pr-snapshot", () => ({
  gitPrSnapshotFile: external.snapshot,
  gitPrSnapshotComparison: external.comparison,
}));
vi.mock("@/features/pulls/mr-chat/persistence", () => ({
  loadMrChats: external.load,
  saveMrChats: external.save,
}));
vi.mock("@/lib/ai/ignore", () => ({
  aiExcludePatterns: async () => [],
  filterDiffByAiIgnore: external.filter,
  filterPathsByAiIgnore: external.paths,
  lossyListingRows: (paths: string[]) =>
    paths.map((path) => ({ path, undecodable: false })),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: external.settings,
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
    readOnly: false,
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
  const draft = renderHook(() =>
    useMrTextDraft(`${mrChatKey(context.mr)}|chat|${context.repoPath}|new`),
  );
  act(() => draft.result.current.set(""));
  draft.unmount();
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
  external.openExternalFile.mockReset();
  external.settings.mockReset().mockResolvedValue(DEFAULT_SETTINGS);
  external.paths
    .mockReset()
    .mockImplementation(async ({ paths }: { paths: { path: string }[] }) => ({
      paths: paths.map((entry) => entry.path),
      excluded: 0,
      unreadable: 0,
    }));
  external.comparison
    .mockReset()
    .mockImplementation(
      async (
        _repo: string,
        _number: number,
        headSha: string,
        path: string,
      ) => ({
        ...comparison,
        headSha,
        oldPath: path,
        newPath: path,
        patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-oldValue()\n+nextValue()\n`,
      }),
    );
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
  enabled = true,
  selectionOptions: {
    request?: MrChatSelectionRequest | null;
    onConsumed?: (id: string) => void;
    onOpenFile?: (reference: string) => void;
  } = {},
) {
  let selectionRequest = selectionOptions.request ?? null;
  let currentContext = current;
  let currentEnabled = enabled;
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
      enabled={currentEnabled}
      onCollapse={onCollapse}
      selectionRequest={selectionRequest}
      onSelectionConsumed={selectionOptions.onConsumed}
      onOpenFile={selectionOptions.onOpenFile}
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
    rerenderContext: (value: MrChatContext) => {
      currentContext = value;
      result.rerender(ui(value));
    },
    rerenderSelection: (value: MrChatSelectionRequest | null) => {
      selectionRequest = value;
      result.rerender(ui(currentContext));
    },
    rerenderEnabled: (value: boolean) => {
      currentEnabled = value;
      result.rerender(ui(currentContext));
    },
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

  it("sends only the MR link when a native conversation starts and resumes without repeating MR metadata", async () => {
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
      readOnly: false,
      resume: false,
      worktreePath: context.repoPath,
    });
    expect(first.userPrompt).toContain(context.url);
    expect(first.userPrompt).toContain("Why is this safe?");
    for (const value of [context.title, context.body, HEAD, "fresh()"])
      expect(first.userPrompt).not.toContain(value);
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
    expect(
      (external.run.mock.calls[1][0] as AgentSessionArgs).userPrompt,
    ).not.toContain(context.url);
  });

  it("starts without fetching or attaching the whole MR diff", async () => {
    const loadDiff = vi.fn(() => new Promise<string>(() => undefined));
    const user = userEvent.setup();
    mountSidebar({ ...context, diff: undefined, loadDiff });
    await user.type(
      screen.getByRole("textbox", { name: "Message about this MR" }),
      "Explain the patch",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(external.run).toHaveBeenCalledTimes(1));
    expect(loadDiff).not.toHaveBeenCalled();
    expect(
      (external.run.mock.calls[0][0] as AgentSessionArgs).userPrompt,
    ).not.toContain("MR diff:");
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

  it("does not automatically include MR descriptions, changed-file listings or source content", async () => {
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
    expect(request.userPrompt).not.toContain("public()");
    expect(request.userPrompt).not.toContain(context.body);
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
    let loaded!: (value: AppSettings) => void;
    const settings = new Promise<AppSettings>((resolve) => {
      loaded = resolve;
    });
    external.settings.mockReturnValueOnce(settings);
    const user = userEvent.setup();
    mountSidebar();
    const editor = screen.getByRole("textbox", {
      name: "Message about this MR",
    });
    await user.type(editor, "Prepare context");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(external.run).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Stop response" }));
    expect(external.cancel).not.toHaveBeenCalled();
    await act(async () => {
      loaded(DEFAULT_SETTINGS);
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

describe("automatic MR file metadata", () => {
  const base = "b".repeat(40);

  it.each(["inert", "hidden"])(
    "holds Send while only a %s file surface remains during handoff",
    async (state) => {
      const user = userEvent.setup();
      const sidebar = mountSidebar();
      act(() => {
        sidebar.host.innerHTML = `<div ${state} data-diff-file-path="src/previous.ts" data-diff-head-sha="${HEAD}"><pre class="gd-code">retained()</pre></div><p role="status">Loading next file</p>`;
      });
      const editor = screen.getByRole("textbox", {
        name: "Message about this MR",
      });
      await user.type(editor, "Wait for the actual file");
      await user.click(screen.getByRole("button", { name: "Send message" }));
      expect(useMrChatStore.getState().sessions).toHaveLength(0);
      expect(external.run).not.toHaveBeenCalled();
      expect(editor).toHaveValue("Wait for the actual file");
      expect(screen.getByRole("alert")).toHaveTextContent(
        "viewed file is still updating",
      );
      expect(external.comparison).not.toHaveBeenCalled();
    },
  );

  async function send(
    user: ReturnType<typeof userEvent.setup>,
    text: string,
    calls: number,
  ) {
    await user.type(
      screen.getByRole("textbox", { name: "Message about this MR" }),
      text,
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(external.run).toHaveBeenCalledTimes(calls));
    return (external.run.mock.calls[calls - 1][0] as AgentSessionArgs)
      .userPrompt;
  }

  function marker(
    path: string,
    before: string,
    after: string,
    beforeRevision = base,
  ) {
    return `<div data-diff-file-path="${path}" data-diff-head-sha="${HEAD}" data-diff-before-path="${before}" data-diff-before-revision="${beforeRevision}" data-diff-after-path="${after}" data-diff-after-revision="${HEAD}"><pre class="gd-code">private source contents</pre></div>`;
  }

  it.each([
    { name: "unchanged", after: "README.md", row: `After: ${HEAD}:README.md` },
    { name: "absent", after: "", row: `After: ${HEAD} (file absent)` },
  ])(
    "sends authoritative after-only metadata for an $name Source preview without an MR comparison",
    async ({ after, row }) => {
      external.comparison.mockRejectedValue(
        new Error("This source file is not changed in the MR"),
      );
      const user = userEvent.setup();
      const sidebar = mountSidebar();
      act(() => {
        sidebar.host.innerHTML = `<div data-diff-file-path="README.md" data-diff-head-sha="${HEAD}" data-diff-content-side="new" data-diff-after-path="${after}" data-diff-after-revision="${HEAD}"><pre class="gd-code">do not include source bytes</pre></div>`;
      });
      const prompt = await send(user, "Explain this source file", 1);
      expect(prompt).toContain("Path: README.md");
      expect(prompt).toContain(row);
      expect(prompt).not.toContain("Before:");
      expect(prompt).not.toContain("do not include source bytes");
      expect(external.comparison).not.toHaveBeenCalled();
      expect(external.snapshot).not.toHaveBeenCalled();
    },
  );

  it("sends both painted file versions on every turn without source bytes or MR payload", async () => {
    const user = userEvent.setup();
    const sidebar = mountSidebar();
    act(() => {
      sidebar.host.innerHTML = marker(
        "src/current.ts",
        "src/previous.ts",
        "src/current.ts",
      );
    });
    const first = await send(user, "Explain this file", 1);
    expect(first).toContain(`Before: ${base}:src/previous.ts`);
    expect(first).toContain(`After: ${HEAD}:src/current.ts`);
    expect(first).not.toContain("private source contents");
    expect(first).not.toContain(context.body);
    expect(first).not.toContain("fresh()");
    const nextBase = "c".repeat(40);
    act(() => {
      sidebar.host.innerHTML = marker(
        "src/next.ts",
        "src/old-next.ts",
        "src/next.ts",
        nextBase,
      );
    });
    const next = await send(user, "And this file?", 2);
    expect(next).toContain(`Before: ${nextBase}:src/old-next.ts`);
    expect(next).toContain(`After: ${HEAD}:src/next.ts`);
    expect(next).not.toContain("src/current.ts");
    expect(next).not.toContain(context.url);
    expect(external.comparison).not.toHaveBeenCalled();
    expect(external.snapshot).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "addition",
      path: "src/added.ts",
      before: "",
      after: "src/added.ts",
      absent: `Before: ${base} (file absent)`,
    },
    {
      name: "deletion",
      path: "src/deleted.ts",
      before: "src/deleted.ts",
      after: "",
      absent: `After: ${HEAD} (file absent)`,
    },
    {
      name: "literal null filename",
      path: "src/new.ts",
      before: "null",
      after: "src/new.ts",
      absent: `Before: ${base}:null`,
    },
  ])(
    "keeps explicit absent sides distinct from real paths for $name",
    async ({ path, before, after, absent }) => {
      const user = userEvent.setup();
      const sidebar = mountSidebar();
      act(() => {
        sidebar.host.innerHTML = marker(path, before, after);
      });
      const prompt = await send(user, "Explain the file transition", 1);
      expect(prompt).toContain(absent);
      expect(external.comparison).not.toHaveBeenCalled();
    },
  );

  it("reads only the current file comparison when painted pair metadata is incomplete", async () => {
    const loadDiff = vi.fn(() =>
      Promise.reject(new Error("Whole MR diff must not load")),
    );
    const user = userEvent.setup();
    const sidebar = mountSidebar({ ...context, loadDiff });
    act(() => {
      sidebar.host.innerHTML = `<div data-diff-file-path="src/focused.ts" data-diff-head-sha="${HEAD}" data-diff-after-path="src/focused.ts" data-diff-after-revision="${HEAD}"><pre class="gd-code">do not send this source</pre></div>`;
    });
    const prompt = await send(user, "Explain the focused file", 1);
    expect(external.comparison).toHaveBeenCalledWith(
      context.repoPath,
      7,
      HEAD,
      "src/focused.ts",
      "origin",
    );
    expect(loadDiff).not.toHaveBeenCalled();
    expect(prompt).toContain(`Before: ${base}:src/focused.ts`);
    expect(prompt).toContain(`After: ${HEAD}:src/focused.ts`);
    expect(prompt).not.toContain("oldValue()");
    expect(prompt).not.toContain("do not send this source");
    expect(external.snapshot).not.toHaveBeenCalled();
  });

  it("keeps the draft when current-file versions cannot be loaded", async () => {
    external.comparison.mockRejectedValueOnce(
      new Error("Could not read file versions"),
    );
    const user = userEvent.setup();
    const sidebar = mountSidebar();
    act(() => {
      sidebar.host.innerHTML = `<div data-diff-file-path="src/focused.ts" data-diff-head-sha="${HEAD}"></div>`;
    });
    const editor = screen.getByRole("textbox", {
      name: "Message about this MR",
    });
    await user.type(editor, "Keep this unsent question");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByRole("alert");
    expect(editor).toHaveValue("Keep this unsent question");
    expect(external.run).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Send message" }),
    ).not.toHaveAttribute("aria-disabled", "true");
  });

  it.each([false, true])(
    "retires pending file context when the MR becomes inactive (reactivated: %s)",
    async (reactivated) => {
      let finish!: (value: PrSnapshotComparison) => void;
      external.comparison.mockReturnValueOnce(
        new Promise<PrSnapshotComparison>((resolve) => {
          finish = resolve;
        }),
      );
      const user = userEvent.setup();
      const sidebar = mountSidebar();
      act(() => {
        sidebar.host.innerHTML = `<div data-diff-file-path="src/cache.ts" data-diff-head-sha="${HEAD}"></div>`;
      });
      const editor = screen.getByRole("textbox", {
        name: "Message about this MR",
      });
      await user.type(editor, "Preserve this unsent question");
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => expect(external.comparison).toHaveBeenCalledOnce());
      sidebar.rerenderEnabled(false);
      if (reactivated) sidebar.rerenderEnabled(true);
      await act(async () => {
        finish(comparison);
      });
      expect(useMrChatStore.getState().sessions).toHaveLength(0);
      expect(external.run).not.toHaveBeenCalled();
      expect(editor).toHaveValue("Preserve this unsent question");
      sidebar.rerenderEnabled(true);
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).not.toHaveAttribute("aria-disabled", "true");
    },
  );

  it.each(["file", "head", "MR"] as const)(
    "rejects a late file-context result after the %s changes",
    async (change) => {
      let finish!: (value: PrSnapshotComparison) => void;
      external.comparison.mockReturnValueOnce(
        new Promise<PrSnapshotComparison>((resolve) => {
          finish = resolve;
        }),
      );
      const user = userEvent.setup();
      const sidebar = mountSidebar();
      act(() => {
        sidebar.host.innerHTML = `<div data-diff-file-path="src/first.ts" data-diff-head-sha="${HEAD}"></div>`;
      });
      await user.type(
        screen.getByRole("textbox", { name: "Message about this MR" }),
        "Do not send against another file",
      );
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => expect(external.comparison).toHaveBeenCalledOnce());
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toHaveAttribute("aria-disabled", "true");
      if (change === "file")
        act(() => {
          sidebar.host.innerHTML = marker(
            "src/second.ts",
            "src/second.ts",
            "src/second.ts",
          );
        });
      else if (change === "head")
        sidebar.rerenderContext({ ...context, headSha: "c".repeat(40) });
      else
        sidebar.rerenderContext({
          ...context,
          mr: { ...context.mr, number: 8 },
          url: context.url.replace(/7$/, "8"),
        });
      await act(async () => {
        finish({
          ...comparison,
          oldPath: "src/first.ts",
          newPath: "src/first.ts",
        });
      });
      expect(external.run).not.toHaveBeenCalled();
      if (change !== "MR")
        expect(
          screen.getByRole("textbox", { name: "Message about this MR" }),
        ).toHaveValue("Do not send against another file");
    },
  );
});

describe("queued Add to chat selections", () => {
  const request = (): MrChatSelectionRequest => ({
    id: "selection-request",
    mr: context.mr,
    repoPath: context.repoPath,
    headSha: HEAD,
    selection: {
      id: "selected",
      kind: "selection",
      path: "src/cache.ts",
      lookupPath: "src/cache.ts",
      side: "old",
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 8,
      text: "oldValue",
      format: "code",
      headSha: HEAD,
    },
  });

  it("attaches verified selected code once without clearing an unsent draft", async () => {
    const consumed = vi.fn();
    const user = userEvent.setup();
    const sidebar = mountSidebar(context, false, {}, true, {
      onConsumed: consumed,
    });
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
    await user.type(
      screen.getByRole("textbox", { name: "Message about this MR" }),
      "Keep my current question",
    );
    const queued = request();
    sidebar.rerenderSelection(queued);
    await screen.findByRole("button", { name: "Remove src/cache.ts" });
    expect(
      screen.getByRole("textbox", { name: "Message about this MR" }),
    ).toHaveValue("Keep my current question");
    expect(consumed).toHaveBeenCalledExactlyOnceWith("selection-request");
    sidebar.rerenderSelection(queued);
    expect(consumed).toHaveBeenCalledTimes(1);
    expect(external.run).not.toHaveBeenCalled();
  });

  it.each(["MR", "repo", "head", "code"] as const)(
    "rejects a stale %s packet and consumes only its matching request id",
    async (change) => {
      const consumed = vi.fn();
      const user = userEvent.setup();
      const sidebar = mountSidebar(context, false, {}, true, {
        onConsumed: consumed,
      });
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
      await user.type(
        screen.getByRole("textbox", { name: "Message about this MR" }),
        "Preserve this draft",
      );
      const queued = request();
      if (change === "MR") queued.mr = { ...queued.mr, number: 8 };
      else if (change === "repo") queued.repoPath = "/repos/another";
      else if (change === "head") queued.headSha = "c".repeat(40);
      else queued.selection = { ...queued.selection, text: "staleVal" };
      sidebar.rerenderSelection(queued);
      await waitFor(() =>
        expect(consumed).toHaveBeenCalledExactlyOnceWith("selection-request"),
      );
      expect(
        screen.queryByRole("button", { name: "Remove src/cache.ts" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("textbox", { name: "Message about this MR" }),
      ).toHaveValue("Preserve this draft");
      expect(external.run).not.toHaveBeenCalled();
    },
  );

  it("routes a saved answer's file reference through the MR navigator", async () => {
    useMrChatStore.setState({
      sessions: [
        savedSession("file-reference", {
          turns: [
            {
              ...savedSession("reference").turns[0],
              narration: "Inspect `src/cache.ts:42`.",
            },
          ],
        }),
      ],
    });
    const opened = vi.fn();
    const user = userEvent.setup();
    mountSidebar(context, false, {}, true, { onOpenFile: opened });
    await user.click(
      await screen.findByRole("button", { name: "Open src/cache.ts" }),
    );
    expect(opened).toHaveBeenCalledExactlyOnceWith("src/cache.ts:42");
    expect(external.openExternalFile).not.toHaveBeenCalled();
  });
});

describe("MR chat harness permissions", () => {
  const permissions = () =>
    screen.getByRole("combobox", { name: "Permissions" });
  const expectLocked = (locked: boolean) => {
    const picker = permissions();
    expect(
      picker.hasAttribute("disabled") ||
        picker.getAttribute("aria-disabled") === "true",
    ).toBe(locked);
  };

  async function choose(
    user: ReturnType<typeof userEvent.setup>,
    label: string,
  ) {
    await user.click(permissions());
    await user.click(await screen.findByRole("option", { name: label }));
  }

  async function send(
    user: ReturnType<typeof userEvent.setup>,
    question: string,
    expectedCalls: number,
  ) {
    await user.type(
      screen.getByRole("textbox", { name: "Message about this MR" }),
      question,
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(external.run).toHaveBeenCalledTimes(expectedCalls),
    );
  }

  it("puts the harness in the header and starts Codex with its Auto profile", async () => {
    const user = userEvent.setup();
    mountSidebar();
    const harness = screen.getByRole("combobox", { name: "Agent" });
    const header = screen
      .getByRole("heading", { name: "Codex chat" })
      .closest("header");
    expect(header).toContainElement(harness);
    expect(screen.queryByText("MR chat")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "New chat" }),
    ).not.toBeInTheDocument();
    expect(permissions()).toHaveTextContent("Auto");
    expect(permissions()).toHaveAccessibleDescription(
      /Working checkout: \/repos\/project/,
    );
    await send(user, "Update the cache", 1);
    expect(external.run.mock.calls[0][0]).toMatchObject({
      readOnly: false,
      permissionMode: "auto",
    });
    expect(await screen.findByText("Completed")).toBeInTheDocument();
    expect(screen.queryByText("No changes")).not.toBeInTheDocument();
  });

  it.each([
    {
      agent: "codex" as const,
      value: "auto",
      label: "Auto",
      options: ["Read-only", "Auto", "Full Access"],
      absent: "Plan",
    },
    {
      agent: "claude" as const,
      value: "bypassPermissions",
      label: "Bypass permissions",
      options: [
        "Plan",
        "Default",
        "Accept edits",
        "Bypass permissions",
        "Auto",
      ],
      absent: "Allow tools",
    },
    {
      agent: "copilot" as const,
      value: "allow-tools",
      label: "Allow tools",
      options: ["Read-only", "Allow tools", "Full Access"],
      absent: "Accept edits",
    },
    {
      agent: "opencode" as const,
      value: "auto",
      label: "Auto",
      options: ["Plan", "Default", "Auto"],
      absent: "Full Access",
    },
  ])(
    "offers only the $agent permission profiles and sends its native default",
    async ({ agent, value, label, options, absent }) => {
      const user = userEvent.setup();
      mountSidebar(context, false, { defaultAgent: agent });
      expect(permissions()).toHaveTextContent(label);
      expect(permissions()).toHaveAttribute(
        "title",
        expect.stringContaining(label),
      );
      await user.click(permissions());
      for (const name of options)
        expect(await screen.findByRole("option", { name })).toBeInTheDocument();
      expect(
        screen.queryByRole("option", { name: absent }),
      ).not.toBeInTheDocument();
      await user.keyboard("{Escape}");
      await send(user, "Inspect the current task", 1);
      expect(external.run.mock.calls[0][0]).toMatchObject({
        agent,
        permissionMode: value,
        readOnly: false,
      });
    },
  );

  it("can select Read-only for a new Codex conversation", async () => {
    const user = userEvent.setup();
    mountSidebar();
    await choose(user, "Read-only");
    await send(user, "Explain the cache", 1);
    const request = external.run.mock.calls[0][0] as AgentSessionArgs;
    expect(request).toMatchObject({
      readOnly: true,
      permissionMode: "read-only",
    });
    expect(request.userPrompt).toContain("Permission mode: Read-only");
  });

  it("changes an idle chat from Read-only to Full Access without replacing its resume id", async () => {
    useMrChatStore.setState({
      sessions: [
        savedSession("permission-chat", {
          nativeSessionId: "native-kept",
          permissionMode: "auto",
        }),
      ],
    });
    const user = userEvent.setup();
    mountSidebar();
    await choose(user, "Read-only");
    await send(user, "First inspect the cache", 1);
    expect(external.run.mock.calls[0][0]).toMatchObject({
      sessionId: "permission-chat",
      nativeSessionId: "native-kept",
      resume: true,
      readOnly: true,
      permissionMode: "read-only",
    });
    await screen.findByText("The cache is now refreshed.");
    await choose(user, "Full Access");
    await send(user, "Now apply the fix", 2);
    expect(external.run.mock.calls[1][0]).toMatchObject({
      sessionId: "permission-chat",
      nativeSessionId: "native-kept",
      resume: true,
      readOnly: false,
      permissionMode: "full-access",
    });
  });

  it("locks permissions until a cancelling transport has settled", async () => {
    let settled!: () => void;
    external.run.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settled = resolve;
        }),
    );
    const user = userEvent.setup();
    mountSidebar();
    await send(user, "Start applying the fix", 1);
    expectLocked(true);
    await user.click(permissions());
    expect(
      screen.queryByRole("option", { name: "Full Access" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop response" }));
    expectLocked(true);
    await user.click(permissions());
    expect(useMrChatStore.getState().sessions[0].permissionMode).toBe("auto");
    await act(async () => {
      settled();
    });
    await screen.findByText("Cancelled.");
    expectLocked(false);
  });

  it.each([
    { name: "inactive MR", interactive: false, cancelling: false },
    { name: "cancellation", interactive: true, cancelling: true },
  ])("locks permissions during $name", async ({ interactive, cancelling }) => {
    useMrChatStore.setState({
      sessions: [
        savedSession("held-mode", { permissionMode: "auto", cancelling }),
      ],
    });
    const user = userEvent.setup();
    mountSidebar(context, false, {}, interactive);
    expectLocked(true);
    await user.click(permissions());
    expect(useMrChatStore.getState().sessions[0].permissionMode).toBe("auto");
    expect(
      screen.queryByRole("option", { name: "Read-only" }),
    ).not.toBeInTheDocument();
  });

  it("holds permission choices while persisted chats load, then enables selection", async () => {
    const user = userEvent.setup();
    let loaded!: (sessions: MrChatSession[]) => void;
    external.load.mockReturnValue(
      new Promise<MrChatSession[]>((resolve) => {
        loaded = resolve;
      }),
    );
    useMrChatStore.setState({ hydrated: false });
    mountSidebar();
    expectLocked(true);
    await user.click(permissions());
    expect(
      screen.queryByRole("option", { name: "Read-only" }),
    ).not.toBeInTheDocument();
    await act(async () => {
      loaded([]);
    });
    expectLocked(false);
    await choose(user, "Read-only");
    expect(permissions()).toHaveTextContent("Read-only");
  });

  it("resets a new draft to the harness default through the session picker", async () => {
    useMrChatStore.setState({
      sessions: [
        savedSession("restricted-chat", {
          readOnly: true,
          permissionMode: "read-only",
        }),
      ],
    });
    const user = userEvent.setup();
    mountSidebar();
    expect(permissions()).toHaveTextContent("Read-only");
    expect(screen.queryByText("Ongoing MR chats")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("combobox", { name: "Ongoing MR chats" }),
    );
    await user.click(await screen.findByRole("option", { name: "New chat" }));
    expect(permissions()).toHaveTextContent("Auto");
    await choose(user, "Full Access");
    await user.click(
      screen.getByRole("combobox", { name: "Ongoing MR chats" }),
    );
    await user.click(await screen.findByRole("option", { name: "New chat" }));
    expect(permissions()).toHaveTextContent("Auto");
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Message about this MR" }),
      ).toHaveFocus(),
    );
    expect(useMrChatStore.getState().sessions[0].permissionMode).toBe(
      "read-only",
    );
  });

  it("keeps each chat and MR permission profile independent", async () => {
    useMrChatStore.setState({
      sessions: [
        savedSession("restricted-chat", {
          readOnly: true,
          permissionMode: "read-only",
        }),
        savedSession("editable-chat", { permissionMode: "auto" }),
        savedSession("other-mr-chat", {
          agent: "claude",
          mr: { ...context.mr, number: 8 },
          readOnly: true,
          permissionMode: "plan",
        }),
      ],
    });
    const user = userEvent.setup();
    const sidebar = mountSidebar();
    await user.click(
      screen.getByRole("combobox", { name: "Ongoing MR chats" }),
    );
    await user.click(
      await screen.findByRole("option", { name: /restricted-chat/ }),
    );
    expect(permissions()).toHaveTextContent("Read-only");
    await choose(user, "Full Access");
    await user.click(
      screen.getByRole("combobox", { name: "Ongoing MR chats" }),
    );
    await user.click(
      await screen.findByRole("option", { name: /editable-chat/ }),
    );
    expect(permissions()).toHaveTextContent("Auto");
    sidebar.rerenderContext({
      ...context,
      mr: { ...context.mr, number: 8 },
      url: context.url.replace(/7$/, "8"),
    });
    expect(permissions()).toHaveTextContent("Plan");
    sidebar.rerenderContext(context);
    expect(permissions()).toHaveTextContent("Auto");
    expect(
      useMrChatStore
        .getState()
        .sessions.find((session) => session.id === "restricted-chat")
        ?.permissionMode,
    ).toBe("full-access");
  });

  it("preserves the selected permission profile across collapse and expansion", async () => {
    const user = userEvent.setup();
    mountSidebar(context, true);
    await choose(user, "Full Access");
    await user.click(screen.getByRole("button", { name: "Collapse MR chat" }));
    await user.click(screen.getByRole("button", { name: "Expand MR chat" }));
    expect(permissions()).toHaveTextContent("Full Access");
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
  it("refuses a cold-cache head-file attachment when its old rename path is AI-excluded", async () => {
    external.paths.mockImplementation(
      async ({ paths }: { paths: { path: string }[] }) => ({
        paths: paths
          .map((entry) => entry.path)
          .filter((path) => path !== "private/cache.ts"),
        excluded: 1,
        unreadable: 0,
      }),
    );
    const user = userEvent.setup();
    const sidebar = mountSidebar();
    act(() => {
      sidebar.host.innerHTML = `<div data-diff-file-path="src/cache.ts" data-diff-old-file-path="private/cache.ts" data-diff-head-sha="${HEAD}" data-diff-before-path="private/cache.ts" data-diff-before-revision="${comparison.baseSha}" data-diff-after-path="src/cache.ts" data-diff-after-revision="${HEAD}"><pre class="gd-code">nextValue()</pre></div>`;
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
    expect(external.snapshot).toHaveBeenCalledWith(
      context.repoPath,
      HEAD,
      "src/cache.ts",
      "origin",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Message about this MR" }),
      "Explain this attached file",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(useMrChatStore.getState().sessions[0]?.running).toBe(false),
    );
    expect(useMrChatStore.getState().sessions[0].turns[0].error).toContain(
      "excluded from AI context",
    );
    expect(external.run).not.toHaveBeenCalled();
    expect(external.comparison).not.toHaveBeenCalled();
  });

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

  it.each([false, true])(
    "retires a pending attachment when the MR becomes inactive (reactivated: %s)",
    async (reactivated) => {
      let finish!: (value: ReturnType<typeof bytes>) => void;
      external.snapshot.mockReturnValueOnce(
        new Promise<ReturnType<typeof bytes>>((resolve) => {
          finish = resolve;
        }),
      );
      const user = userEvent.setup();
      const sidebar = mountSidebar();
      act(() => {
        sidebar.host.innerHTML = `<div data-diff-file-path="src/cache.ts" data-diff-head-sha="${HEAD}"><pre class="gd-code">nextValue()</pre></div>`;
      });
      const editor = screen.getByRole("textbox", {
        name: "Message about this MR",
      });
      await user.type(editor, "Keep this attachment draft");
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Attach current file" }),
        ).not.toHaveAttribute("aria-disabled", "true"),
      );
      await user.click(
        screen.getByRole("button", { name: "Attach current file" }),
      );
      await waitFor(() => expect(external.snapshot).toHaveBeenCalledOnce());
      sidebar.rerenderEnabled(false);
      if (reactivated) sidebar.rerenderEnabled(true);
      await act(async () => {
        finish(bytes("nextValue()\n"));
      });
      expect(
        screen.queryByRole("button", { name: "Remove src/cache.ts" }),
      ).not.toBeInTheDocument();
      expect(editor).toHaveValue("Keep this attachment draft");
      expect(external.run).not.toHaveBeenCalled();
      sidebar.rerenderEnabled(true);
      expect(
        screen.getByRole("button", { name: "Attach current file" }),
      ).not.toHaveAttribute("aria-disabled", "true");
    },
  );

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
