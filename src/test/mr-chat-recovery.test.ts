import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMrChatPrompt,
  type MrChatContext,
} from "@/features/pulls/mr-chat/context";
import {
  type MrChatSession,
  useMrChatStore,
} from "@/features/pulls/mr-chat/store";
import type { AgentSessionArgs, ReviewEvent } from "@/lib/ai/agent";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";

const external = vi.hoisted(() => ({
  run: vi.fn(),
  cancel: vi.fn(),
  filter: vi.fn(),
  settings: vi.fn(),
}));
vi.mock("@/lib/ai/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/agent")>()),
  runAgentSession: external.run,
  cancelAgentSession: external.cancel,
}));
vi.mock("@/features/pulls/mr-chat/persistence", () => ({
  loadMrChats: async () => [],
  saveMrChats: async () => undefined,
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: external.settings,
}));
vi.mock("@/lib/ai/ignore", () => ({
  aiExcludePatterns: async () => [],
  filterDiffByAiIgnore: external.filter,
  filterPathsByAiIgnore: async () => ({ paths: [] }),
  lossyListingRows: () => [],
}));

const OLD_ID = "01a1ed9a-9725-7e20-8193-d25b4c6658b8";
const NEW_ID = "01a1ed9b-9725-7e20-8193-d25b4c6658b8";
const context: MrChatContext = {
  mr: { host: "git.example.com", repoFullName: "team/project", number: 7 },
  repoPath: "/repo",
  url: "https://git.example.com/team/project/-/merge_requests/7",
  title: "Refresh the cache",
  body: "Keep cached results current.",
  baseRefName: "master",
  headRefName: "fix/cache",
  headSha: "a".repeat(40),
  files: [{ path: "cache.ts" }],
  diff: "+fresh()",
};
const missing = (id = OLD_ID): ReviewEvent => ({
  kind: "error",
  message: `Error: thread/resume: thread/resume failed: no rollout found for thread id ${id} (code -32600)`,
  partialText: null,
  timedOut: false,
});
function saved(): MrChatSession {
  return {
    id: "saved-chat",
    mr: context.mr,
    repoPath: context.repoPath,
    agent: "codex",
    model: "chosen-model",
    effort: "xhigh",
    readOnly: true,
    nativeSessionId: OLD_ID,
    state: "active",
    running: false,
    turns: [
      {
        prompt: "What does this MR change?",
        narration: "It refreshes the cache after writes.",
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
const current = () => useMrChatStore.getState().sessions[0];
const finished = () => waitFor(() => expect(current().running).toBe(false));
function send(value = context) {
  useMrChatStore.getState().send("saved-chat", value, "Please continue", []);
}
function succeed(args: AgentSessionArgs) {
  args.onEvent({ kind: "nativeSession", id: NEW_ID });
  args.onEvent({
    kind: "done",
    text: "Continued with the saved discussion.",
    isError: false,
    costUsd: null,
  });
}

beforeEach(() => {
  external.run
    .mockReset()
    .mockImplementation(async (args: AgentSessionArgs) => {
      succeed(args);
      return null;
    });
  external.cancel.mockReset().mockResolvedValue(undefined);
  external.settings.mockReset().mockResolvedValue(DEFAULT_SETTINGS);
  external.filter.mockReset().mockImplementation(async ({ text, files }) => ({
    text,
    files,
    excludedFiles: 0,
    unreadableFiles: 0,
    unkeyableSections: 0,
  }));
  useMrChatStore.setState({ sessions: [saved()], hydrated: true });
});

describe("missing Codex MR conversation", () => {
  it("keeps edits allowed when recovering a write-enabled conversation", async () => {
    useMrChatStore.setState({ sessions: [{ ...saved(), readOnly: false }] });
    external.run.mockImplementationOnce(async (args: AgentSessionArgs) => {
      args.onEvent(missing());
      return null;
    });
    send();
    await finished();
    expect(external.run.mock.calls.map(([args]) => args.readOnly)).toEqual([
      false,
      false,
    ]);
    expect(current().readOnly).toBe(false);
    expect(current().turns.at(-1)?.status).toBe("done");
  });

  it("rebuilds the same chat from prior messages and its MR link without loading the whole diff", async () => {
    const loadDiff = vi
      .fn()
      .mockResolvedValueOnce("+oldPatch()")
      .mockResolvedValueOnce("+currentPatch()");
    external.run.mockImplementationOnce(async (args: AgentSessionArgs) => {
      args.onEvent(missing());
      return null;
    });
    send({ ...context, diff: undefined, loadDiff });
    await finished();
    expect(external.run).toHaveBeenCalledTimes(2);
    const retry = external.run.mock.calls[1][0] as AgentSessionArgs;
    expect(retry).toMatchObject({
      sessionId: "saved-chat",
      resume: false,
      nativeSessionId: null,
      readOnly: true,
      isolation: "worktree",
      model: "chosen-model",
      effort: "xhigh",
    });
    for (const text of [
      context.url,
      "What does this MR change?",
      "It refreshes the cache after writes.",
      "Please continue",
    ])
      expect(retry.userPrompt).toContain(text);
    expect(retry.userPrompt).not.toContain("+oldPatch()");
    expect(retry.userPrompt).not.toContain("no rollout found");
    expect(loadDiff).not.toHaveBeenCalled();
    expect(external.filter).not.toHaveBeenCalled();
    expect(external.run.mock.calls[0][0].userPrompt).not.toContain(context.url);
    expect(retry.userPrompt).not.toContain(context.body);
    expect(retry.userPrompt).not.toContain("+currentPatch()");
    expect(current().id).toBe("saved-chat");
    expect(current().nativeSessionId).toBe(NEW_ID);
    expect(current().turns).toHaveLength(2);
    expect(current().turns[0]).toEqual(saved().turns[0]);
    expect(current().turns[1].status).toBe("done");
    send();
    await finished();
    expect(external.run.mock.calls[2][0]).toMatchObject({
      resume: true,
      nativeSessionId: NEW_ID,
    });
  });

  it("recovers only once when an invocation rejects with the exact missing-thread error", async () => {
    external.run.mockRejectedValueOnce(
      new Error((missing() as { message: string }).message),
    );
    external.run.mockImplementationOnce(async (args: AgentSessionArgs) => {
      args.onEvent(missing());
      return null;
    });
    send();
    await finished();
    expect(external.run).toHaveBeenCalledTimes(2);
    expect(current().turns.at(-1)?.status).toBe("error");
    expect(current().nativeSessionId).toBeNull();
  });

  it("rebuilds saved Codex messages without resuming an unrelated last thread when no ID was persisted", async () => {
    useMrChatStore.setState({
      sessions: [{ ...saved(), nativeSessionId: null }],
    });
    send();
    await finished();
    expect(external.run).toHaveBeenCalledTimes(1);
    expect(external.run.mock.calls[0][0]).toMatchObject({
      resume: false,
      nativeSessionId: null,
    });
    expect(external.run.mock.calls[0][0].userPrompt).toContain(
      "What does this MR change?",
    );
  });

  it.each(["", "  "])(
    "replaces a blank saved ID (%s) with the recovered native thread",
    async (nativeSessionId) => {
      useMrChatStore.setState({ sessions: [{ ...saved(), nativeSessionId }] });
      send();
      await finished();
      expect(current().nativeSessionId).toBe(NEW_ID);
      send();
      await finished();
      expect(external.run.mock.calls[1][0]).toMatchObject({
        resume: true,
        nativeSessionId: NEW_ID,
      });
    },
  );

  it.each([
    { name: "another thread", event: missing(NEW_ID) },
    {
      name: "authentication error",
      event: {
        kind: "error",
        message: "Not logged in",
        partialText: null,
        timedOut: false,
      },
    },
    { name: "timeout", event: { ...missing(), timedOut: true } },
    {
      name: "partial answer",
      event: { ...missing(), partialText: "A partial answer" },
    },
  ])("does not retry $name", async ({ event }) => {
    external.run.mockImplementationOnce(async (args: AgentSessionArgs) => {
      args.onEvent(event as ReviewEvent);
      return null;
    });
    send();
    await finished();
    expect(external.run).toHaveBeenCalledTimes(1);
    expect(current().nativeSessionId).toBe(OLD_ID);
    expect(current().turns.at(-1)?.status).toBe("error");
  });

  it("does not replay a write-enabled turn that already ran a tool", async () => {
    useMrChatStore.setState({ sessions: [{ ...saved(), readOnly: false }] });
    external.run.mockImplementationOnce(async (args: AgentSessionArgs) => {
      args.onEvent({
        kind: "tool",
        tool: "write",
        target: "cache.ts",
      });
      args.onEvent(missing());
      return null;
    });
    send();
    await finished();
    expect(external.run).toHaveBeenCalledTimes(1);
    expect(external.run.mock.calls[0][0].readOnly).toBe(false);
    expect(current().turns.at(-1)?.segments).toEqual([
      { type: "tool", tool: "write", target: "cache.ts" },
    ]);
  });

  it("honors Stop while the missing-thread transport is still settling", async () => {
    let settle!: () => void;
    const pending = new Promise<null>((resolve) => {
      settle = () => resolve(null);
    });
    external.run.mockImplementationOnce((args: AgentSessionArgs) => {
      args.onEvent(missing());
      return pending;
    });
    send();
    try {
      await waitFor(() => expect(external.run).toHaveBeenCalledTimes(1));
      useMrChatStore.getState().cancel("saved-chat", context);
    } finally {
      settle();
    }
    await finished();
    expect(external.run).toHaveBeenCalledTimes(1);
    expect(current().turns.at(-1)?.error).toBe("Cancelled.");
    expect(current().nativeSessionId).toBe(OLD_ID);
    expect(external.cancel).not.toHaveBeenCalled();
    send();
    await finished();
    expect(external.run).toHaveBeenCalledTimes(2);
    expect(current().turns.at(-1)?.status).toBe("done");
  });

  it("waits for the rejected channel to settle and ignores its late events during recovery", async () => {
    let oldArgs!: AgentSessionArgs;
    let freshArgs!: AgentSessionArgs;
    let releaseOld!: () => void;
    let releaseFresh!: () => void;
    const oldTransport = new Promise<null>((resolve) => {
      releaseOld = () => resolve(null);
    });
    const freshTransport = new Promise<null>((resolve) => {
      releaseFresh = () => resolve(null);
    });
    external.run
      .mockImplementationOnce((args: AgentSessionArgs) => {
        oldArgs = args;
        args.onEvent(missing());
        return oldTransport;
      })
      .mockImplementationOnce((args: AgentSessionArgs) => {
        freshArgs = args;
        args.onEvent({ kind: "nativeSession", id: NEW_ID });
        return freshTransport;
      });
    send();
    try {
      await waitFor(() => expect(external.run).toHaveBeenCalledTimes(1));
      expect(current().turns.at(-1)?.status).toBe("running");
      expect(current().nativeSessionId).toBe(OLD_ID);
      releaseOld();
      await waitFor(() => expect(external.run).toHaveBeenCalledTimes(2));
      oldArgs.onEvent({ kind: "delta", text: "Late stale answer" });
      oldArgs.onEvent(missing());
      expect(current().turns.at(-1)?.narration).toBe("");
      expect(current().turns.at(-1)?.status).toBe("running");
      expect(current().nativeSessionId).toBe(NEW_ID);
      freshArgs.onEvent({
        kind: "done",
        text: "Recovered answer",
        isError: false,
        costUsd: null,
      });
    } finally {
      releaseOld();
      releaseFresh();
    }
    await finished();
    expect(current().turns.at(-1)?.narration).toBe("Recovered answer");
  });

  it("accepts a matching channel failure followed by its matching invocation rejection", async () => {
    external.run.mockImplementationOnce(async (args: AgentSessionArgs) => {
      args.onEvent(missing());
      throw new Error((missing() as { message: string }).message);
    });
    send();
    await finished();
    expect(external.run).toHaveBeenCalledTimes(2);
    expect(current().turns.at(-1)?.status).toBe("done");
  });
});

describe("OpenCode MR scope without a native session ID", () => {
  it.each([null, "", "  "])(
    "starts fresh with saved MR messages when the persisted id is %j",
    async (nativeSessionId) => {
      const other = {
        ...saved(),
        id: "other-mr-chat",
        agent: "opencode" as const,
        mr: { ...context.mr, number: 8 },
        nativeSessionId: "ses_other_mr",
      };
      useMrChatStore.setState({
        sessions: [{ ...saved(), agent: "opencode", nativeSessionId }, other],
      });
      send();
      await finished();
      const args = external.run.mock.calls[0][0] as AgentSessionArgs;
      expect(args).toMatchObject({
        agent: "opencode",
        resume: false,
        nativeSessionId: null,
      });
      expect(args.userPrompt).toContain(context.url);
      expect(args.userPrompt).toContain("What does this MR change?");
      expect(args.userPrompt).toContain("It refreshes the cache after writes.");
      expect(args.userPrompt).not.toContain("ses_other_mr");
      expect(current().nativeSessionId).toBe(NEW_ID);
      send();
      await finished();
      expect(external.run.mock.calls[1][0]).toMatchObject({
        resume: true,
        nativeSessionId: NEW_ID,
      });
    },
  );
});

describe("restored MR message history", () => {
  it("bounds old conversation data and labels omitted history without duplicating the current question", () => {
    const history = Array.from({ length: 8 }, (_, index) => ({
      prompt: `Question ${index}: ${"x".repeat(20_000)}`,
      narration: `Answer ${index}: ${"y".repeat(30_000)}`,
      status: "done",
    }));
    const prompt = buildMrChatPrompt(
      { ...context, diff: "" },
      "Current question",
      [],
      { history },
    );
    expect(prompt).toContain("History truncated");
    expect(prompt).toContain("Context truncated");
    expect(prompt).toContain("Question 7:");
    expect(prompt).toContain("Answer 7:");
    expect(prompt).not.toContain("Question 0:");
    expect(prompt.split("Current question")).toHaveLength(2);
    expect(prompt.length).toBeLessThan(62_000);
  });
});
