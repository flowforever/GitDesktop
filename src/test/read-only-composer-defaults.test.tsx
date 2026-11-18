import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanComposer } from "@/features/plan/PlanView";
import { usePlanStore } from "@/features/plan/store";
import { ResearchComposer } from "@/features/research/ResearchView";
import { useResearchStore } from "@/features/research/store";
import type { AgentKind } from "@/lib/ai/agent";
import type { AppSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";

const launches = vi.hoisted(() => ({ plan: vi.fn(), research: vi.fn() }));
vi.mock("@/lib/plugin-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/plugin-store")>()),
  memoizedStoreLoader: () => async () => ({
    get: async () => undefined,
    set: async () => undefined,
    save: async () => undefined,
  }),
}));
vi.mock("@/features/plan/persistence", () => ({
  loadPersistedPlans: async () => [],
  savePersistedPlans: async () => undefined,
}));
vi.mock("@/features/research/persistence", () => ({
  loadPersistedResearch: async () => [],
  savePersistedResearch: async () => undefined,
}));
vi.mock("@/features/sessions/persistence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/sessions/persistence")>()),
  loadPersistedSessions: async () => [],
}));

const settings: AppSettings = {
  ...DEFAULT_SETTINGS,
  defaultAgent: "codex",
  agentDefaults: {
    codex: { model: "configured-codex", effort: "high" },
    claude: { model: "configured-claude", effort: "medium" },
  },
};
const clients: QueryClient[] = [];
beforeEach(() => {
  launches.plan.mockReset().mockReturnValue("plan-result");
  launches.research.mockReset().mockReturnValue("research-result");
  usePlanStore.setState({ start: launches.plan });
  useResearchStore.setState({ start: launches.research });
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

function mount(kind: "plan" | "research") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  client.setQueryData(settingsKeys.settings, settings);
  for (const agent of [
    "claude",
    "codex",
    "copilot",
    "opencode",
  ] satisfies AgentKind[])
    client.setQueryData(["agent-models", agent], { models: [], live: false });
  render(
    <QueryClientProvider client={client}>
      {kind === "plan" ? (
        <PlanComposer repoPath="/repos/project" seed={null} />
      ) : (
        <ResearchComposer repoPath="/repos/project" seed={null} />
      )}
    </QueryClientProvider>,
  );
  return {
    client,
    launched: kind === "plan" ? launches.plan : launches.research,
    submitLabel: kind === "plan" ? "Plan" : "Research",
    promptLabel:
      kind === "plan"
        ? "Describe a task to plan"
        : "Describe a topic to research",
  };
}

async function chooseEffort(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
) {
  await user.click(screen.getByRole("button", { name: "Run options" }));
  await user.click(await screen.findByRole("radio", { name: label }));
  await user.keyboard("{Escape}");
}

async function submit(
  user: ReturnType<typeof userEvent.setup>,
  view: ReturnType<typeof mount>,
) {
  await user.type(
    screen.getByRole("textbox", { name: view.promptLabel }),
    "Investigate the current behavior",
  );
  await user.click(screen.getByRole("button", { name: view.submitLabel }));
}

describe.each(["plan", "research"] as const)(
  "%s composer harness defaults",
  (kind) => {
    it("uses the configured harness model and thinking effort for a new conversation", async () => {
      const user = userEvent.setup();
      const view = mount(kind);
      expect(screen.getByRole("combobox", { name: "Agent model" })).toHaveValue(
        "configured-codex",
      );
      await submit(user, view);
      expect(view.launched).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: "codex",
          model: "configured-codex",
          effort: "high",
        }),
      );
    });

    it("derives updated settings while the model and effort remain untouched", async () => {
      const user = userEvent.setup();
      const view = mount(kind);
      act(() =>
        view.client.setQueryData(settingsKeys.settings, {
          ...settings,
          agentDefaults: {
            ...settings.agentDefaults,
            codex: { model: "updated-codex", effort: "xhigh" },
          },
        }),
      );
      await waitFor(() =>
        expect(
          screen.getByRole("combobox", { name: "Agent model" }),
        ).toHaveValue("updated-codex"),
      );
      await submit(user, view);
      expect(view.launched).toHaveBeenCalledWith(
        expect.objectContaining({ model: "updated-codex", effort: "xhigh" }),
      );
    });

    it("keeps explicit blank model and effort overrides when settings change", async () => {
      const user = userEvent.setup();
      const view = mount(kind);
      const model = screen.getByRole("combobox", { name: "Agent model" });
      await user.clear(model);
      await user.keyboard("{Escape}");
      await chooseEffort(user, "Auto");
      act(() =>
        view.client.setQueryData(settingsKeys.settings, {
          ...settings,
          agentDefaults: {
            ...settings.agentDefaults,
            codex: { model: "updated-codex", effort: "xhigh" },
          },
        }),
      );
      await submit(user, view);
      expect(model).toHaveValue("");
      expect(view.launched).toHaveBeenCalledWith(
        expect.objectContaining({ model: "", effort: "" }),
      );
    });

    it("uses the selected harness defaults without carrying the prior harness overrides", async () => {
      const user = userEvent.setup();
      const view = mount(kind);
      const model = screen.getByRole("combobox", { name: "Agent model" });
      await user.clear(model);
      await user.type(model, "manual-codex");
      await user.keyboard("{Escape}");
      await chooseEffort(user, "Low");
      await user.click(screen.getByRole("combobox", { name: "Agent" }));
      await user.click(await screen.findByRole("option", { name: "Claude" }));
      await waitFor(() => expect(model).toHaveValue("configured-claude"));
      await submit(user, view);
      expect(view.launched).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: "claude",
          model: "configured-claude",
          effort: "medium",
        }),
      );
    });

    it("retains explicit model and effort choices when the same harness settings change", async () => {
      const user = userEvent.setup();
      const view = mount(kind);
      const model = screen.getByRole("combobox", { name: "Agent model" });
      await user.clear(model);
      await user.type(model, "manual-codex");
      await user.keyboard("{Escape}");
      await chooseEffort(user, "Low");
      act(() =>
        view.client.setQueryData(settingsKeys.settings, {
          ...settings,
          agentDefaults: {
            ...settings.agentDefaults,
            codex: { model: "updated-codex", effort: "xhigh" },
          },
        }),
      );
      await submit(user, view);
      expect(view.launched).toHaveBeenCalledWith(
        expect.objectContaining({ model: "manual-codex", effort: "low" }),
      );
    });

    it("does not carry model or effort overrides across a settings-driven default harness change", async () => {
      const user = userEvent.setup();
      const view = mount(kind);
      const model = screen.getByRole("combobox", { name: "Agent model" });
      await user.clear(model);
      await user.type(model, "manual-codex");
      await user.keyboard("{Escape}");
      await chooseEffort(user, "Low");
      act(() =>
        view.client.setQueryData(settingsKeys.settings, {
          ...settings,
          defaultAgent: "claude",
        }),
      );
      await waitFor(() => expect(model).toHaveValue("configured-claude"));
      await submit(user, view);
      expect(view.launched).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: "claude",
          model: "configured-claude",
          effort: "medium",
        }),
      );
    });
  },
);
