import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentSessionArgs, runAgentSession } from "@/lib/ai/agent";

const bridge = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tauri/invoke", () => ({ invoke: bridge }));
vi.mock("@tauri-apps/api/core", () => ({ Channel: class {} }));

beforeEach(() => bridge.mockReset().mockResolvedValue(null));

const args = (): AgentSessionArgs => ({
  agent: "codex",
  binPath: null,
  model: "",
  effort: "",
  systemPrompt: "Read the code",
  userPrompt: "Continue",
  worktreePath: "/repo",
  sessionId: "app-session",
  resume: true,
  nativeSessionId: null,
  isolation: "worktree",
  readOnly: true,
  onEvent: vi.fn(),
});

describe("Codex host resume identity", () => {
  it.each([null, "", "  "])(
    "rejects an absent native ID (%s) before starting the CLI",
    async (id) => {
      await expect(
        runAgentSession({ ...args(), nativeSessionId: id }),
      ).rejects.toThrow(/session ID/);
      expect(bridge).not.toHaveBeenCalled();
    },
  );

  it("resumes a specific host thread", async () => {
    await runAgentSession({ ...args(), nativeSessionId: "native-thread" });
    expect(bridge).toHaveBeenCalledWith(
      "agent_session",
      expect.objectContaining({
        resume: true,
        nativeSessionId: "native-thread",
      }),
    );
  });

  it("keeps first turns and isolated container resumes available without a native ID", async () => {
    await runAgentSession({ ...args(), resume: false });
    await runAgentSession({ ...args(), isolation: "container" });
    expect(bridge).toHaveBeenCalledTimes(2);
  });
});
