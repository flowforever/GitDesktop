import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogHost } from "@/components/confirm-dialog-host";
import { SettingsScreen } from "@/features/settings/SettingsScreen";
import { listAgentModels } from "@/lib/ai/agent";
import {
  type AppSettings,
  loadSettings,
  saveSettingsMerged,
} from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
  saveSettingsMerged: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  getSecret: vi.fn(async () => null),
}));
vi.mock("@/lib/ai/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/agent")>()),
  listAgentModels: vi.fn(async (agent: string) => [`${agent}-catalog-model`]),
  detectAgentCli: vi.fn(async () => ({
    found: true,
    path: "/test/agent",
    version: "1.0",
    authed: "authed",
  })),
}));
vi.mock("@/lib/automations/store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/automations/store")>();
  return {
    ...actual,
    loadAutomations: vi.fn(async () => actual.normalizeAutomations(undefined)),
  };
});

let stored: AppSettings;

beforeEach(() => {
  vi.clearAllMocks();
  useConfirm.getState().answer(false);
  useUiStore.setState(useUiStore.getInitialState(), true);
  stored = {
    ...structuredClone(DEFAULT_SETTINGS),
    defaultAgent: "codex",
    agentDefaults: {
      claude: { model: "private-claude", effort: "low" },
      codex: { model: "private-codex", effort: "high" },
      opencode: { model: "provider/unchanged", effort: "medium" },
    },
  };
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(stored),
  );
  vi.mocked(saveSettingsMerged).mockImplementation(async (next) => {
    stored = structuredClone(next);
    return structuredClone(stored);
  });
});

async function openSettings() {
  const user = userEvent.setup();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  act(() => useUiStore.getState().openSettings("ai"));
  render(
    <QueryClientProvider client={client}>
      <SettingsScreen />
      <ConfirmDialogHost />
    </QueryClientProvider>,
  );
  await screen.findByRole("combobox", { name: "Default harness" });
  return user;
}

const harness = () => screen.getByRole("combobox", { name: "Default harness" });
const model = () => screen.getByRole("combobox", { name: "Default model" });
const effort = () => screen.getByRole("combobox", { name: "Thinking effort" });

async function chooseHarness(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.click(harness());
  const popup = await screen.findByRole("listbox");
  await user.click(await screen.findByRole("option", { name }));
  await waitFor(() => expect(popup).not.toBeVisible());
}

async function editModel(
  user: ReturnType<typeof userEvent.setup>,
  value: string,
) {
  await user.clear(model());
  if (value) await user.type(model(), value);
  const popup = screen.queryByRole("listbox");
  if (model().getAttribute("aria-expanded") === "true")
    await user.keyboard("{Escape}");
  if (popup) await waitFor(() => expect(popup).not.toBeVisible());
}

async function chooseEffort(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.click(effort());
  const popup = await screen.findByRole("listbox");
  await user.click(await screen.findByRole("option", { name }));
  await waitFor(() => expect(popup).not.toBeVisible());
}

describe("default harness settings", () => {
  it("keeps per-harness edits in the existing Save form and probes the model catalog only on intent", async () => {
    const user = await openSettings();
    expect(harness()).toHaveTextContent("Codex");
    expect(model()).toHaveValue("private-codex");
    expect(effort()).toHaveTextContent("High");
    expect(listAgentModels).not.toHaveBeenCalled();

    await editModel(user, "custom-provider/my-model");
    await waitFor(() => expect(listAgentModels).toHaveBeenCalledWith("codex"));
    await chooseEffort(user, "Max");
    await chooseHarness(user, "Claude");
    expect(model()).toHaveValue("private-claude");
    expect(effort()).toHaveTextContent("Low");
    await editModel(user, "claude-personal");
    await chooseHarness(user, "Codex");
    expect(model()).toHaveValue("custom-provider/my-model");
    expect(effort()).toHaveTextContent("Max");
    expect(saveSettingsMerged).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      expect(stored.agentDefaults).toEqual({
        claude: { model: "claude-personal", effort: "low" },
        codex: { model: "custom-provider/my-model", effort: "xhigh" },
        opencode: { model: "provider/unchanged", effort: "medium" },
      });
    });
    expect(stored.defaultAgent).toBe("codex");
    await waitFor(() =>
      expect(
        screen.queryByText("You have unsaved changes"),
      ).not.toBeInTheDocument(),
    );
  });

  it("follows the CLI provider in Auto and discards model, effort, and harness edits together", async () => {
    stored.defaultAgent = undefined;
    stored.ai.provider = "codex-cli";
    const initial = structuredClone(stored.agentDefaults);
    const user = await openSettings();
    expect(harness()).toHaveTextContent("Auto");
    expect(model()).toHaveValue("private-codex");
    await chooseEffort(user, "Medium");
    await chooseHarness(user, "Claude");
    await editModel(user, "discard-this-model");
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
    await user.click(screen.getByRole("button", { name: "Discard changes" }));

    await waitFor(() => expect(harness()).toHaveTextContent("Auto"));
    expect(model()).toHaveValue("private-codex");
    expect(effort()).toHaveTextContent("High");
    expect(stored.agentDefaults).toEqual(initial);
    expect(stored.defaultAgent).toBeUndefined();
    expect(saveSettingsMerged).not.toHaveBeenCalled();
  });

  it("uses Claude for Auto with an HTTP provider and saves explicit CLI-default blanks", async () => {
    stored.defaultAgent = undefined;
    const user = await openSettings();
    expect(harness()).toHaveTextContent("Auto");
    expect(model()).toHaveValue("private-claude");
    expect(effort()).toHaveTextContent("Low");
    await editModel(user, "");
    await chooseEffort(user, "Default");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      expect(stored.agentDefaults?.claude).toEqual({ model: "", effort: "" });
    });
    expect(stored.agentDefaults?.codex).toEqual({
      model: "private-codex",
      effort: "high",
    });
    expect(stored.defaultAgent).toBeUndefined();
  });
});
