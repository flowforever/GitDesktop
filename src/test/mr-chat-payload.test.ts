import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MrChatContext,
  MrChatFileContext,
} from "@/features/pulls/mr-chat/context";
import { useMrChatStore } from "@/features/pulls/mr-chat/store";
import type { AgentKind, AgentSessionArgs } from "@/lib/ai/agent";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";

const external = vi.hoisted(() => ({ run: vi.fn(), paths: vi.fn() }));
vi.mock("@/lib/ai/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/agent")>()),
  runAgentSession: external.run,
}));
vi.mock("@/features/pulls/mr-chat/persistence", () => ({
  loadMrChats: async () => [],
  saveMrChats: async () => undefined,
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: async () => DEFAULT_SETTINGS,
}));
vi.mock("@/lib/ai/ignore", () => ({
  aiExcludePatterns: async () => [],
  filterPathsByAiIgnore: external.paths,
  lossyListingRows: (paths: string[]) =>
    paths.map((path) => ({ path, undecodable: false })),
}));

const context: MrChatContext = {
  mr: { host: "git.example.com", repoFullName: "team/project", number: 7 },
  repoPath: "/repo",
  url: "https://git.example.com/team/project/-/merge_requests/7",
  title: "Never implicitly include the title",
  body: "Never implicitly include the description",
  baseRefName: "main",
  headRefName: "topic",
  headSha: "a".repeat(40),
  files: [{ path: "elsewhere.ts" }],
  diff: "+neverImplicitlyIncludeDiff()",
};
const file: MrChatFileContext = {
  path: "src/cache.ts",
  before: { path: "src/previous.ts", revision: "b".repeat(40) },
  after: { path: "src/cache.ts", revision: "a".repeat(40) },
};
const idle = () =>
  waitFor(() =>
    expect(useMrChatStore.getState().sessions[0].running).toBe(false),
  );
beforeEach(() => {
  external.run
    .mockReset()
    .mockImplementation(async (args: AgentSessionArgs) => {
      args.onEvent({ kind: "nativeSession", id: "saved-native-id" });
      args.onEvent({
        kind: "done",
        text: "A reply",
        isError: false,
        costUsd: null,
      });
      return null;
    });
  external.paths
    .mockReset()
    .mockImplementation(async ({ paths }: { paths: { path: string }[] }) => ({
      paths: paths.map((entry) => entry.path),
      excluded: 0,
      unreadable: 0,
    }));
  useMrChatStore.setState({ sessions: [], hydrated: true });
});

describe("MR chat on-demand payload", () => {
  it.each(["codex", "claude", "copilot", "opencode"] as AgentKind[])(
    "sends the link once and current file versions every turn with %s",
    async (agent) => {
      const loadDiff = vi
        .fn()
        .mockRejectedValue(new Error("Whole MR reads are forbidden"));
      const target = { ...context, diff: undefined, loadDiff };
      const id = useMrChatStore
        .getState()
        .start(target, "First question", agent, "", "", [], undefined, file);
      await idle();
      expect(external.run).toHaveBeenCalledOnce();
      const first = external.run.mock.calls[0][0] as AgentSessionArgs;
      expect(first.userPrompt).toContain(context.url);
      expect(first.userPrompt).toContain(
        `${file.before!.revision}:src/previous.ts`,
      );
      expect(first.userPrompt).toContain(
        `${file.after!.revision}:src/cache.ts`,
      );
      for (const omitted of [
        context.title,
        context.body,
        context.diff!,
        "elsewhere.ts",
      ])
        expect(first.userPrompt).not.toContain(omitted);
      const next = {
        ...file,
        path: "src/other.ts",
        before: { ...file.before!, path: "src/other.ts" },
        after: { ...file.after!, path: "src/other.ts" },
      };
      useMrChatStore.getState().send(id, target, "Next question", [], next);
      await idle();
      const second = external.run.mock.calls[1][0] as AgentSessionArgs;
      expect(second.resume).toBe(true);
      expect(second.userPrompt).not.toContain(context.url);
      expect(second.userPrompt).not.toContain("src/cache.ts");
      expect(second.userPrompt).toContain(
        `${next.before.revision}:src/other.ts`,
      );
      expect(second.userPrompt).toContain(
        `${next.after.revision}:src/other.ts`,
      );
      expect(second.userPrompt).not.toContain("<restored-conversation>");
      expect(loadDiff).not.toHaveBeenCalled();
    },
  );

  it.each(["src/cache.ts", "src/previous.ts"])(
    "withholds the entire current-file identity when %s is excluded",
    async (excluded) => {
      external.paths.mockImplementation(
        async ({ paths }: { paths: { path: string }[] }) => ({
          paths: paths
            .map((entry) => entry.path)
            .filter((path) => path !== excluded),
          excluded: 1,
          unreadable: 0,
        }),
      );
      useMrChatStore
        .getState()
        .start(context, "Explain", "codex", "", "", [], undefined, file);
      await idle();
      expect(external.run).toHaveBeenCalledOnce();
      const prompt = external.run.mock.calls[0][0].userPrompt;
      expect(prompt).not.toContain("src/cache.ts");
      expect(prompt).not.toContain("src/previous.ts");
      expect(prompt).not.toContain(file.before!.revision);
    },
  );

  it("rejects an explicit code attachment when either rename path is excluded", async () => {
    external.paths.mockResolvedValue({
      paths: ["src/previous.ts"],
      excluded: 1,
      unreadable: 0,
    });
    useMrChatStore.getState().start(context, "Explain", "codex", "", "", [
      {
        id: "selected",
        kind: "selection",
        format: "code",
        path: "src/previous.ts",
        lookupPath: "src/cache.ts",
        side: "old",
        text: "selectedSecret()",
      },
    ]);
    await idle();
    expect(external.run).not.toHaveBeenCalled();
    expect(useMrChatStore.getState().sessions[0].turns[0].error).toContain(
      "excluded",
    );
  });

  it("rejects an attached new version when its verified rename source is excluded", async () => {
    external.paths.mockResolvedValue({
      paths: ["src/cache.ts"],
      excluded: 1,
      unreadable: 0,
    });
    useMrChatStore
      .getState()
      .start(context, "Explain this selected code", "codex", "", "", [
        {
          id: "new-selection",
          kind: "selection",
          format: "code",
          path: "src/cache.ts",
          lookupPath: "src/cache.ts",
          relatedPaths: ["secrets/cache.ts", "src/cache.ts"],
          side: "new",
          text: "secretMovedIntoNewVersion()",
        },
      ]);
    await idle();
    expect(external.run).not.toHaveBeenCalled();
    expect(useMrChatStore.getState().sessions[0].turns[0].error).toContain(
      "excluded",
    );
  });

  it("checks both filename headers before sending an explicit patch attachment", async () => {
    external.paths.mockResolvedValue({
      paths: ["src/cache.ts"],
      excluded: 1,
      unreadable: 0,
    });
    useMrChatStore
      .getState()
      .start(context, "Explain this patch", "codex", "", "", [
        {
          id: "patch",
          kind: "file",
          format: "diff",
          path: "src/cache.ts",
          side: "new",
          text: "diff --git a/secrets/cache.ts b/src/cache.ts\n--- a/secrets/cache.ts\n+++ b/src/cache.ts\n@@ -1 +1 @@\n-oldSecret()\n+nextSecret()\n",
        },
      ]);
    await idle();
    expect(external.run).not.toHaveBeenCalled();
  });

  it("rejects file metadata for a different displayed MR head", async () => {
    useMrChatStore
      .getState()
      .start(context, "Explain", "codex", "", "", [], undefined, {
        ...file,
        after: { path: "src/cache.ts", revision: "c".repeat(40) },
      });
    await idle();
    expect(external.run).not.toHaveBeenCalled();
    expect(useMrChatStore.getState().sessions[0].turns[0].error).toContain(
      "snapshot",
    );
  });
});
