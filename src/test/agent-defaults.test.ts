import { describe, expect, it } from "vitest";
import { type AgentKind, agentDefaultsFor } from "@/lib/ai/agent";
import type { AppSettings } from "@/lib/settings/api";

describe("new conversation defaults", () => {
  it("keeps the CLI defaults when no harness preference was saved", () => {
    for (const settings of [undefined, null, {}, { agentDefaults: {} }]) {
      expect(agentDefaultsFor(settings, "codex")).toEqual({
        model: "",
        effort: "",
      });
    }
  });

  it("resolves only the selected harness's model and effort", () => {
    const settings = {
      agentDefaults: {
        claude: { model: "private-claude", effort: "low" },
        codex: { model: "private-codex", effort: "xhigh" },
        copilot: { model: "private-copilot", effort: "medium" },
        opencode: { model: "custom-provider/model:preview", effort: "high" },
      },
    };
    for (const [agent, expected] of [
      ["claude", { model: "private-claude", effort: "low" }],
      ["codex", { model: "private-codex", effort: "xhigh" }],
      ["copilot", { model: "private-copilot", effort: "medium" }],
      ["opencode", { model: "custom-provider/model:preview", effort: "high" }],
    ] as const) {
      expect(agentDefaultsFor(settings, agent)).toEqual(expected);
    }
    expect(
      agentDefaultsFor(
        { agentDefaults: { codex: settings.agentDefaults.codex } },
        "claude",
      ),
    ).toEqual({ model: "", effort: "" });
  });

  it("normalizes unhealed values without discarding a valid sibling field", () => {
    const settings = {
      agentDefaults: {
        claude: { model: " custom/model ", effort: "high" },
        codex: { model: "private-codex", effort: "turbo" },
        copilot: { model: 42, effort: "medium" },
        opencode: ["custom/model", "low"],
      },
    } as unknown as Pick<AppSettings, "agentDefaults">;
    for (const [agent, expected] of [
      ["claude", { model: "custom/model", effort: "high" }],
      ["codex", { model: "private-codex", effort: "" }],
      ["copilot", { model: "", effort: "medium" }],
      ["opencode", { model: "", effort: "" }],
    ] as const) {
      expect(agentDefaultsFor(settings, agent)).toEqual(expected);
    }
  });

  it("returns independent values without modifying saved defaults", () => {
    const settings = {
      agentDefaults: {
        codex: { model: "private-codex", effort: "high" },
      },
    };
    const resolved = agentDefaultsFor(settings, "codex");
    resolved.model = "one-conversation-override";
    resolved.effort = "low";
    expect(settings.agentDefaults.codex).toEqual({
      model: "private-codex",
      effort: "high",
    });
    for (const agent of ["claude", "codex"] satisfies AgentKind[]) {
      expect(agentDefaultsFor(settings, agent)).toEqual(
        agent === "codex"
          ? { model: "private-codex", effort: "high" }
          : { model: "", effort: "" },
      );
    }
  });
});
