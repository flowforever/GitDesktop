import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentKind,
  type AgentSessionArgs,
  runAgentSession,
} from "@/lib/ai/agent";
import type { AgentPermissionMode } from "@/lib/ai/agent-permissions";

const bridge = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tauri/invoke", () => ({ invoke: bridge }));
vi.mock("@tauri-apps/api/core", () => ({ Channel: class {} }));

beforeEach(() => bridge.mockReset().mockResolvedValue(null));

const args = (agent: AgentKind): AgentSessionArgs => ({
  agent,
  binPath: null,
  model: "chosen-model",
  effort: "high",
  systemPrompt: "Discuss this MR",
  userPrompt: "Explain the selected code",
  worktreePath: "/repo",
  sessionId: "app-session",
  resume: false,
  nativeSessionId: null,
  isolation: "worktree",
  readOnly: false,
  onEvent: vi.fn(),
});

const profiles: [AgentKind, AgentPermissionMode, boolean][] = [
  ["codex", "read-only", true],
  ["codex", "auto", false],
  ["codex", "full-access", false],
  ["claude", "plan", true],
  ["claude", "default", false],
  ["claude", "auto", false],
  ["claude", "acceptEdits", false],
  ["claude", "bypassPermissions", false],
  ["copilot", "read-only", true],
  ["copilot", "allow-tools", false],
  ["copilot", "full-access", false],
  ["opencode", "plan", true],
  ["opencode", "default", false],
  ["opencode", "auto", false],
];

describe("native session permission profiles", () => {
  it.each(profiles)(
    "forwards %s mode %s with read-only %s",
    async (agent, permissionMode, readOnly) => {
      await runAgentSession({
        ...args(agent),
        permissionMode,
        readOnly,
        mcpSelf: true,
      });
      expect(bridge).toHaveBeenCalledWith(
        "agent_session",
        expect.objectContaining({
          agent,
          permissionMode,
          readOnly,
          mcpSelf: true,
          model: "chosen-model",
          effort: "high",
        }),
      );
    },
  );

  it("does not select an explicit mode for existing callers", async () => {
    await runAgentSession(args("claude"));
    expect(bridge.mock.calls[0][1].permissionMode).toBeUndefined();
  });
});
