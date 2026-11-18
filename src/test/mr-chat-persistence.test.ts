import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadMrChats, saveMrChats } from "@/features/pulls/mr-chat/persistence";

const disk = vi.hoisted(() => ({ value: [] as unknown, save: vi.fn() }));
vi.mock("@/lib/plugin-store", () => ({
  memoizedStoreLoader: () => async () => ({
    get: async () => disk.value,
    set: async (_key: string, value: unknown[]) => {
      disk.value = value;
    },
    save: disk.save,
  }),
  reloadToleratingEmptyStore: async () => undefined,
}));
vi.mock("@/lib/app-store-lock", () => ({
  withAppStoreLock: async (_file: string, task: () => Promise<unknown>) =>
    task(),
}));
vi.mock("@/lib/plugin-store-rollback", () => ({
  writeWithRollback: async (_store: unknown, task: () => Promise<unknown>) =>
    task(),
}));

function record(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    mr: { host: "git.example.com", repoFullName: "group/project", number: 7 },
    repoPath: "/repos/project",
    agent: "codex",
    model: "",
    effort: "",
    nativeSessionId: `native-${id}`,
    state: "active",
    running: false,
    turns: [
      {
        prompt: "Question",
        narration: "Answer",
        status: "done",
        statusText: "",
        segments: [],
        commitHash: null,
        costUsd: null,
        error: null,
      },
    ],
    ...extra,
  };
}

beforeEach(() => {
  disk.value = [];
  disk.save.mockReset().mockResolvedValue(undefined);
});

describe("durable MR conversation scope", () => {
  it.each([
    ["codex", "auto"],
    ["claude", "bypassPermissions"],
    ["copilot", "allow-tools"],
    ["opencode", "auto"],
  ])(
    "migrates %s chats to the CLI profile matching their prior edit permission",
    async (agent, permissionMode) => {
      disk.value = [record("legacy", { agent, readOnly: false })];
      expect((await loadMrChats())[0]).toMatchObject({
        permissionMode,
        readOnly: false,
      });
    },
  );

  it("roundtrips a selected full-access profile", async () => {
    disk.value = [
      record("selected", { readOnly: false, permissionMode: "full-access" }),
    ];
    const sessions = await loadMrChats();
    await saveMrChats(sessions);
    expect((await loadMrChats())[0]).toMatchObject({
      permissionMode: "full-access",
      readOnly: false,
    });
  });

  it.each(["bypassPermissions", "unknown", null, 0, {}, undefined])(
    "refuses a malformed or cross-harness saved profile (%j)",
    async (permissionMode) => {
      disk.value = [record("invalid", { readOnly: false, permissionMode })];
      expect((await loadMrChats())[0]).toMatchObject({
        permissionMode: "read-only",
        readOnly: true,
      });
    },
  );

  it("keeps an inconsistent saved profile read-only", async () => {
    disk.value = [
      record("inconsistent", { readOnly: true, permissionMode: "full-access" }),
    ];
    expect((await loadMrChats())[0]).toMatchObject({
      permissionMode: "read-only",
      readOnly: true,
    });
  });

  it("allows edits in legacy chats without a saved permission flag", async () => {
    disk.value = [record("legacy")];
    expect((await loadMrChats())[0].readOnly).toBe(false);
  });

  it.each([true, false])(
    "persists an explicit read-only mode of %s",
    async (readOnly) => {
      disk.value = [record("permission", { readOnly })];
      const [session] = await loadMrChats();
      expect(session.readOnly).toBe(readOnly);
      await saveMrChats([session]);
      expect((await loadMrChats())[0].readOnly).toBe(readOnly);
    },
  );

  it.each([null, undefined, 0, 1, "false", "true", [], {}])(
    "keeps an invalid saved permission flag (%j) read-only",
    async (readOnly) => {
      disk.value = [record("invalid-permission", { readOnly })];
      expect((await loadMrChats())[0].readOnly).toBe(true);
    },
  );

  it.each([true, false])(
    "roundtrips a validated Claude CLI session with readiness %s",
    async (claudeSessionReady) => {
      const claudeSessionId = "72ec53b8-e757-44ca-8059-79d4b486f35e";
      disk.value = [
        record("claude-chat", {
          agent: "claude",
          claudeSessionId,
          claudeSessionReady,
        }),
      ];
      const [session] = await loadMrChats();
      expect(session).toMatchObject({ claudeSessionId, claudeSessionReady });
      await saveMrChats([session]);
      expect((await loadMrChats())[0]).toMatchObject({
        claudeSessionId,
        claudeSessionReady,
      });
    },
  );

  it.each([null, undefined, "", "not-a-uuid", "--resume", 1, [], {}])(
    "rejects an invalid Claude session ID (%j) even when marked ready",
    async (claudeSessionId) => {
      disk.value = [
        record("legacy-claude", {
          agent: "claude",
          claudeSessionId,
          claudeSessionReady: true,
        }),
      ];
      const [session] = await loadMrChats();
      expect(session.claudeSessionId).toBeUndefined();
      expect(session.claudeSessionReady).not.toBe(true);
    },
  );

  it.each([null, undefined, 0, 1, "true", [], {}])(
    "does not trust a nonboolean Claude readiness flag (%j)",
    async (claudeSessionReady) => {
      const claudeSessionId = "72ec53b8-e757-44ca-8059-79d4b486f35e";
      disk.value = [
        record("claude-chat", {
          agent: "claude",
          claudeSessionId,
          claudeSessionReady,
        }),
      ];
      const [session] = await loadMrChats();
      expect(session.claudeSessionId).toBe(claudeSessionId);
      expect(session.claudeSessionReady).toBe(false);
    },
  );

  it("requires explicit scope metadata and never recovers a scope from prompt text", async () => {
    disk.value = [
      record("scoped"),
      record("title-looks-scoped", {
        mr: undefined,
        turns: [
          {
            prompt: "MR !7 in group/project",
            narration: "",
            status: "done",
            statusText: "",
            commitHash: null,
            costUsd: null,
            error: null,
          },
        ],
      }),
      record("wrong-iid-type", {
        mr: {
          host: "git.example.com",
          repoFullName: "group/project",
          number: "7",
        },
      }),
      record("wrong-state", { state: "archived" }),
      null,
    ];
    expect((await loadMrChats()).map((session) => session.id)).toEqual([
      "scoped",
    ]);
  });

  it("restores the same MR/native session and marks an interrupted turn idle", async () => {
    disk.value = [
      record("interrupted", {
        running: true,
        turns: [
          {
            prompt: "Pending question",
            narration: "partial",
            status: "running",
            statusText: "Reading",
            segments: [],
            commitHash: null,
            costUsd: null,
            error: null,
          },
        ],
      }),
    ];
    const [session] = await loadMrChats();
    expect(session).toMatchObject({
      running: false,
      state: "active",
      nativeSessionId: "native-interrupted",
      mr: { host: "git.example.com", repoFullName: "group/project", number: 7 },
    });
    expect(session.turns[0]).toMatchObject({
      status: "error",
      statusText: "",
      narration: "partial",
    });
  });

  it("merges another window's sessions when saving a completed current chat", async () => {
    disk.value = [
      record("current"),
      record("other-window", {
        mr: {
          host: "git.example.com",
          repoFullName: "elsewhere/project",
          number: 7,
        },
      }),
    ];
    const sessions = await loadMrChats();
    await saveMrChats([{ ...sessions[0], state: "completed" }]);
    expect(
      (await loadMrChats()).map((session) => [session.id, session.state]),
    ).toEqual([
      ["current", "completed"],
      ["other-window", "active"],
    ]);
    expect(disk.save).toHaveBeenCalledTimes(1);
  });

  it("leaves unknown or archived history intact when a current conversation is saved", async () => {
    const archived = record("archived", { state: "archived" });
    disk.value = [record("current"), archived];
    const sessions = await loadMrChats();
    await saveMrChats(sessions);
    expect(disk.value).toEqual([
      expect.objectContaining({ id: "current" }),
      archived,
    ]);
  });

  it("refuses to write over a top-level format it cannot read", async () => {
    disk.value = { chats: "unreadable" };
    await expect(loadMrChats()).rejects.toThrow("unreadable format");
    await expect(saveMrChats([])).rejects.toThrow("unreadable format");
    expect(disk.save).not.toHaveBeenCalled();
  });

  it("preserves a newer transcript from another window when an unrelated local chat changes", async () => {
    vi.useFakeTimers();
    try {
      disk.value = [
        record("shared-chat"),
        record("local-chat", {
          mr: {
            host: "git.example.com",
            repoFullName: "group/project",
            number: 8,
          },
        }),
      ];
      const { useMrChatStore } = await import("@/features/pulls/mr-chat/store");
      useMrChatStore.setState({ sessions: [], hydrated: false });
      await useMrChatStore.getState().hydrate();
      const shared = useMrChatStore
        .getState()
        .sessions.find((session) => session.id === "shared-chat");
      const local = useMrChatStore
        .getState()
        .sessions.find((session) => session.id === "local-chat");
      if (!shared || !local) throw new Error("Missing hydrated chat fixture");

      await saveMrChats([
        {
          ...shared,
          turns: [
            ...shared.turns,
            {
              ...shared.turns[0],
              prompt: "Second question from another window",
              narration: "Newer answer from another window",
            },
          ],
        },
      ]);
      useMrChatStore.getState().setModel(
        local.id,
        {
          mr: local.mr,
          repoPath: local.repoPath,
          url: "https://git.example.com/group/project/-/merge_requests/8",
          title: "Other MR",
          body: "",
          baseRefName: "master",
          headRefName: "feature",
          files: [],
        },
        "selected-model",
      );
      await vi.advanceTimersByTimeAsync(800);

      const saved = await loadMrChats();
      expect(
        saved
          .find((session) => session.id === "shared-chat")
          ?.turns.map((turn) => turn.narration),
      ).toEqual(["Answer", "Newer answer from another window"]);
      expect(saved.find((session) => session.id === "local-chat")?.model).toBe(
        "selected-model",
      );
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
