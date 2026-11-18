import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentKind,
  type AgentSessionArgs,
  runAgentSession,
} from "@/lib/ai/agent";

const bridge = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tauri/invoke", () => ({ invoke: bridge }));
vi.mock("@tauri-apps/api/core", () => ({ Channel: class {} }));

beforeEach(() => bridge.mockReset().mockResolvedValue(null));

const args = (agent: AgentKind): AgentSessionArgs => ({
  agent,
  binPath: null,
  model: "",
  effort: "",
  systemPrompt: "Discuss this MR",
  userPrompt: "Explain the selected code",
  worktreePath: "/repo",
  sessionId: "app-session",
  resume: false,
  nativeSessionId: null,
  isolation: "worktree",
  readOnly: true,
  onEvent: vi.fn(),
});

describe("MR chat's built-in MCP transport opt-in", () => {
  it.each(["claude", "codex", "copilot", "opencode"] as const)(
    "passes the bound remote for %s without granting write tools",
    async (agent) => {
      await runAgentSession({
        ...args(agent),
        mcpSelf: true,
        mcpSelfRemote: "upstream",
      });
      expect(bridge).toHaveBeenCalledWith(
        "agent_session",
        expect.objectContaining({
          agent,
          mcpSelf: true,
          mcpSelfRemote: "upstream",
          mcpServers: undefined,
          readOnly: true,
        }),
      );
    },
  );

  it("leaves built-in MCP disabled for callers that did not opt in", async () => {
    await runAgentSession(args("claude"));
    expect(bridge).toHaveBeenCalledWith(
      "agent_session",
      expect.objectContaining({ mcpSelf: false }),
    );
  });

  it("keeps the editing permission independent from the MCP opt-in", async () => {
    await runAgentSession({
      ...args("codex"),
      readOnly: false,
      mcpSelf: true,
      mcpSelfRemote: "origin",
    });
    expect(bridge).toHaveBeenCalledWith(
      "agent_session",
      expect.objectContaining({
        mcpSelf: true,
        mcpSelfRemote: "origin",
        readOnly: false,
      }),
    );
  });
});
