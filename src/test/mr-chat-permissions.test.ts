import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MrChatContext } from "@/features/pulls/mr-chat/context";
import {
  type MrChatSession,
  useMrChatStore,
} from "@/features/pulls/mr-chat/store";
import type { AgentKind, AgentSessionArgs } from "@/lib/ai/agent";
import type { AgentPermissionMode } from "@/lib/ai/agent-permissions";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";

const transport = vi.hoisted(() => ({
  run: vi.fn(),
  cancel: vi.fn(),
  settings: vi.fn(),
}));
vi.mock("@/lib/ai/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/agent")>()),
  runAgentSession: transport.run,
  cancelAgentSession: transport.cancel,
}));
vi.mock("@/features/pulls/mr-chat/persistence", () => ({
  loadMrChats: async () => [],
  saveMrChats: async () => undefined,
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: transport.settings,
}));
vi.mock("@/lib/ai/ignore", () => ({
  aiExcludePatterns: async () => [],
  filterDiffByAiIgnore: async ({
    text,
    files,
  }: {
    text: string;
    files: { path: string }[];
  }) => ({ text, files, excludedFiles: 0, unkeyableSections: 0 }),
  filterPathsByAiIgnore: async () => ({ paths: [] }),
  lossyListingRows: () => [],
}));

const context: MrChatContext = {
  mr: { host: "git.example.com", repoFullName: "team/project", number: 7 },
  repoPath: "/repo",
  url: "https://git.example.com/team/project/-/merge_requests/7",
  title: "Update the cache",
  body: "Keep the cache current.",
  baseRefName: "main",
  headRefName: "cache",
  headSha: "a".repeat(40),
  files: [{ path: "cache.ts" }],
  diff: "+current()",
};

function saved(): MrChatSession {
  return {
    id: "current-chat",
    mr: context.mr,
    repoPath: context.repoPath,
    agent: "codex",
    model: "chosen-model",
    effort: "high",
    readOnly: false,
    nativeSessionId: "saved-native-thread",
    state: "active",
    running: false,
    turns: [
      {
        prompt: "Explain the cache",
        narration: "It stores recent values.",
        status: "done",
        statusText: "",
        segments: [],
        commitHash: null,
        costUsd: null,
        error: null,
      },
    ],
  };
}

function finish(args: AgentSessionArgs) {
  args.onEvent({
    kind: "done",
    text: "Finished the requested task.",
    isError: false,
    costUsd: null,
  });
}

const current = () => useMrChatStore.getState().sessions[0];
const idle = () => waitFor(() => expect(current().running).toBe(false));

beforeEach(() => {
  transport.run
    .mockReset()
    .mockImplementation(async (args: AgentSessionArgs) => {
      finish(args);
      return null;
    });
  transport.cancel.mockReset().mockResolvedValue(undefined);
  transport.settings.mockReset().mockResolvedValue(DEFAULT_SETTINGS);
  useMrChatStore.setState({ sessions: [], hydrated: true });
});

describe("MR conversation permissions", () => {
  it.each([
    ["codex", "full-access", false],
    ["codex", "auto", false],
    ["claude", "acceptEdits", false],
    ["claude", "plan", true],
    ["copilot", "allow-tools", false],
    ["copilot", "full-access", false],
    ["opencode", "default", false],
    ["opencode", "plan", true],
  ] as [AgentKind, AgentPermissionMode, boolean][])(
    "starts %s with its selected %s CLI profile",
    async (agent, mode, readOnly) => {
      useMrChatStore
        .getState()
        .start(context, "Explain or edit", agent, "", "", [], mode);
      await idle();
      expect(current()).toMatchObject({ permissionMode: mode, readOnly });
      expect(transport.run.mock.calls[0][0]).toMatchObject({
        permissionMode: mode,
        readOnly,
        mcpSelf: true,
        mcpSelfRemote: "origin",
      });
    },
  );

  it("rejects a permission profile that belongs to another harness", () => {
    useMrChatStore.setState({ sessions: [saved()] });
    useMrChatStore
      .getState()
      .setPermissionMode("current-chat", context, "bypassPermissions");
    expect(current().permissionMode).toBeUndefined();
    expect(
      useMrChatStore
        .getState()
        .start(context, "Edit", "codex", "", "", [], "bypassPermissions"),
    ).toBeNull();
  });

  it("preserves a saved full-access mode when resuming", async () => {
    useMrChatStore.setState({
      sessions: [{ ...saved(), permissionMode: "full-access" }],
    });
    useMrChatStore.getState().send("current-chat", context, "Continue", []);
    await idle();
    expect(transport.run.mock.calls[0][0]).toMatchObject({
      resume: true,
      readOnly: false,
      permissionMode: "full-access",
    });
  });

  it("starts with edits allowed when no mode was supplied", async () => {
    useMrChatStore
      .getState()
      .start(context, "Update this code", "codex", "", "", []);
    await idle();
    expect(current().readOnly).toBe(false);
    expect(transport.run.mock.calls[0][0].readOnly).toBe(false);
  });

  it("keeps an explicitly read-only new conversation read-only", async () => {
    useMrChatStore
      .getState()
      .start(context, "Explain this code", "codex", "", "", [], "read-only");
    await idle();
    expect(current().readOnly).toBe(true);
    expect(transport.run.mock.calls[0][0].readOnly).toBe(true);
  });

  it("changes permission only for future turns of the matching idle chat", async () => {
    useMrChatStore.setState({ sessions: [saved()] });
    useMrChatStore
      .getState()
      .setPermissionMode("current-chat", context, "read-only");
    expect(current().readOnly).toBe(true);
    useMrChatStore.getState().send("current-chat", context, "Explain it", []);
    await idle();
    expect(transport.run.mock.calls[0][0].readOnly).toBe(true);
    useMrChatStore
      .getState()
      .setPermissionMode("current-chat", context, "auto");
    useMrChatStore.getState().send("current-chat", context, "Update it", []);
    await idle();
    expect(transport.run.mock.calls[1][0].readOnly).toBe(false);
  });

  it.each([
    { ...context, repoPath: "/other-repo" },
    { ...context, mr: { ...context.mr, number: 8 } },
    { ...context, mr: { ...context.mr, host: "other.example.com" } },
    { ...context, mr: { ...context.mr, repoFullName: "other/project" } },
  ])(
    "refuses permission changes from another MR or repository (%j)",
    (other) => {
      useMrChatStore.setState({ sessions: [saved()] });
      useMrChatStore
        .getState()
        .setPermissionMode("current-chat", other, "read-only");
      expect(current().readOnly).toBe(false);
    },
  );

  it("refuses permission changes for an ended conversation", () => {
    useMrChatStore.setState({ sessions: [{ ...saved(), state: "completed" }] });
    useMrChatStore
      .getState()
      .setPermissionMode("current-chat", context, "read-only");
    expect(current().readOnly).toBe(false);
  });

  it("holds the chosen mode while context is preparing", async () => {
    let resolve!: (settings: typeof DEFAULT_SETTINGS) => void;
    const pending = new Promise<typeof DEFAULT_SETTINGS>((done) => {
      resolve = done;
    });
    transport.settings.mockReturnValueOnce(pending);
    const id = useMrChatStore
      .getState()
      .start(context, "Update it", "codex", "", "", []);
    if (!id) throw new Error("The conversation did not start");
    try {
      useMrChatStore.getState().setPermissionMode(id, context, "read-only");
      expect(current().readOnly).toBe(false);
    } finally {
      resolve(DEFAULT_SETTINGS);
      await idle();
    }
    expect(transport.run.mock.calls[0][0].readOnly).toBe(false);
  });

  it("holds the chosen mode until the completed transport releases its flight", async () => {
    let settle!: () => void;
    transport.run.mockImplementationOnce((args: AgentSessionArgs) => {
      finish(args);
      return new Promise<null>((resolve) => {
        settle = () => resolve(null);
      });
    });
    useMrChatStore.setState({ sessions: [saved()] });
    useMrChatStore.getState().send("current-chat", context, "Update it", []);
    await waitFor(() => expect(transport.run).toHaveBeenCalledOnce());
    try {
      useMrChatStore
        .getState()
        .setPermissionMode("current-chat", context, "read-only");
      expect(current().readOnly).toBe(false);
      expect(current().running).toBe(true);
    } finally {
      settle();
      await idle();
    }
    useMrChatStore
      .getState()
      .setPermissionMode("current-chat", context, "read-only");
    expect(current().readOnly).toBe(true);
  });
});

describe("Claude MR permission migration", () => {
  const legacy = (): MrChatSession => ({
    ...saved(),
    agent: "claude",
    nativeSessionId: null,
  });

  it("reserves the new chat's UUID and marks it ready after a successful turn", async () => {
    const id = useMrChatStore
      .getState()
      .start(context, "Update this code", "claude", "", "", []);
    expect(current()).toMatchObject({
      id,
      claudeSessionId: id,
      claudeSessionReady: false,
    });
    await idle();
    expect(current().claudeSessionReady).toBe(true);
    expect(transport.run.mock.calls[0][0]).toMatchObject({
      sessionId: id,
      resume: false,
      readOnly: false,
    });
  });

  it("refreshes a legacy CLI session with saved messages and the current permission", async () => {
    useMrChatStore.setState({ sessions: [legacy()] });
    useMrChatStore.getState().send("current-chat", context, "Update it", []);
    await idle();
    const args = transport.run.mock.calls[0][0] as AgentSessionArgs;
    expect(args.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(args.sessionId).not.toBe("current-chat");
    expect(args).toMatchObject({ resume: false, readOnly: false });
    expect(args.userPrompt).toContain("Explain the cache");
    expect(args.userPrompt).toContain("It stores recent values.");
    expect(args.userPrompt).toContain("Permission mode: Allow edits");
    expect(current()).toMatchObject({
      id: "current-chat",
      claudeSessionId: args.sessionId,
      claudeSessionReady: true,
    });
    expect(current().turns).toHaveLength(2);
    expect(current().turns[0]).toEqual(legacy().turns[0]);
  });

  it("resumes the refreshed session across later permission changes", async () => {
    useMrChatStore.setState({ sessions: [legacy()] });
    useMrChatStore.getState().send("current-chat", context, "Update it", []);
    await idle();
    const id = transport.run.mock.calls[0][0].sessionId;
    useMrChatStore
      .getState()
      .setPermissionMode("current-chat", context, "plan");
    useMrChatStore.getState().send("current-chat", context, "Explain it", []);
    await idle();
    useMrChatStore
      .getState()
      .setPermissionMode("current-chat", context, "bypassPermissions");
    useMrChatStore.getState().send("current-chat", context, "Update again", []);
    await idle();
    expect(transport.run.mock.calls[1][0]).toMatchObject({
      sessionId: id,
      resume: true,
      readOnly: true,
    });
    expect(transport.run.mock.calls[2][0]).toMatchObject({
      sessionId: id,
      resume: true,
      readOnly: false,
    });
    expect(transport.run.mock.calls[1][0].userPrompt).toContain(
      "Permission mode: Read-only",
    );
    expect(transport.run.mock.calls[2][0].userPrompt).toContain(
      "Permission mode: Allow edits",
    );
  });

  it("uses another fresh UUID after startup failed without engine progress", async () => {
    transport.run.mockImplementationOnce(async (args: AgentSessionArgs) => {
      args.onEvent({ kind: "status", text: "Starting" });
      args.onEvent({ kind: "delta", text: "" });
      args.onEvent({
        kind: "error",
        message: "Could not start Claude",
        partialText: null,
        timedOut: false,
      });
      return null;
    });
    useMrChatStore.setState({ sessions: [legacy()] });
    useMrChatStore.getState().send("current-chat", context, "Update it", []);
    await idle();
    expect(current().claudeSessionReady).toBe(false);
    expect(transport.run).toHaveBeenCalledOnce();
    const failedId = transport.run.mock.calls[0][0].sessionId;
    useMrChatStore.getState().send("current-chat", context, "Try again", []);
    await idle();
    const args = transport.run.mock.calls[1][0] as AgentSessionArgs;
    expect(args.sessionId).not.toBe(failedId);
    expect(args).toMatchObject({ resume: false, readOnly: false });
    expect(args.userPrompt).toContain("Explain the cache");
    expect(args.userPrompt).toContain("Update it");
    expect(args.userPrompt).toContain("Try again");
    expect(current().claudeSessionReady).toBe(true);
  });

  it.each(["tool", "delta"] as const)(
    "resumes after %s progress even if that turn later failed",
    async (kind) => {
      transport.run.mockImplementationOnce(async (args: AgentSessionArgs) => {
        args.onEvent(
          kind === "tool"
            ? { kind, tool: "write", target: "cache.ts" }
            : { kind, text: "Updating the cache" },
        );
        args.onEvent({
          kind: "error",
          message: "Connection lost",
          partialText: null,
          timedOut: false,
        });
        return null;
      });
      useMrChatStore.setState({ sessions: [legacy()] });
      useMrChatStore.getState().send("current-chat", context, "Update it", []);
      await idle();
      expect(current().claudeSessionReady).toBe(true);
      const id = transport.run.mock.calls[0][0].sessionId;
      useMrChatStore.getState().send("current-chat", context, "Continue", []);
      await idle();
      expect(transport.run.mock.calls[1][0]).toMatchObject({
        sessionId: id,
        resume: true,
      });
    },
  );

  it("stops the actual CLI session while retaining the visible chat ID", async () => {
    let settle!: () => void;
    transport.run.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          settle = () => resolve(null);
        }),
    );
    useMrChatStore.setState({ sessions: [legacy()] });
    useMrChatStore.getState().send("current-chat", context, "Update it", []);
    await waitFor(() => expect(transport.run).toHaveBeenCalledOnce());
    try {
      const id = transport.run.mock.calls[0][0].sessionId;
      expect(id).not.toBe("current-chat");
      useMrChatStore.getState().cancel("current-chat", context);
      await waitFor(() => expect(transport.cancel).toHaveBeenCalledWith(id));
      expect(current()).toMatchObject({
        id: "current-chat",
        running: true,
        cancelling: true,
      });
    } finally {
      settle();
      await idle();
    }
    expect(current().turns.at(-1)?.error).toBe("Cancelled.");
  });
});
