import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionComposer } from "@/features/sessions/SessionComposer";
import { type AgentSession, useSessionsStore } from "@/features/sessions/store";
import type { AgentKind } from "@/lib/ai/agent";
import type { AppSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";

const query = vi.hoisted(() => ({
  data: undefined as AppSettings | undefined,
  isError: false,
}));
vi.mock("@/lib/settings/queries", () => ({
  useSettings: () => query,
  useRepoKeys: () => ["/repo"],
}));
vi.mock("@/lib/git/queries", () => ({
  useTrackedFiles: () => ({ data: [] }),
  useAgentCommands: () => ({ data: [] }),
}));
vi.mock("@/lib/ai/sandbox-queries", () => ({
  useContainerStatus: () => ({ data: undefined, isError: false }),
}));
vi.mock("@/features/sessions/EnsembleRunDialog", () => ({
  EnsembleRunDialog: () => null,
}));
vi.mock("@/features/sessions/AgentPickers", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/sessions/AgentPickers")
  >()),
  AgentPicker: ({
    value,
    onChange,
  }: {
    value: AgentKind;
    onChange: (value: AgentKind) => void;
  }) => (
    <select
      aria-label="Harness"
      value={value}
      onChange={(event) => onChange(event.target.value as AgentKind)}
    >
      <option value="claude">Claude</option>
      <option value="codex">Codex</option>
    </select>
  ),
  ModelPicker: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <input
      aria-label="Model"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
  ComposerOptions: ({
    effort,
    onEffort,
    isolation,
  }: {
    effort?: string;
    onEffort?: (value: string) => void;
    isolation?: { onSettingsAction: () => void };
  }) => (
    <>
      <input
        aria-label="Thinking effort"
        value={effort ?? ""}
        onChange={(event) => onEffort?.(event.target.value)}
      />
      {isolation ? (
        <button type="button" onClick={isolation.onSettingsAction}>
          Settings round trip
        </button>
      ) : null}
    </>
  ),
}));

const start = vi.fn();
const send = vi.fn();
const defaults = () => ({
  ...DEFAULT_SETTINGS,
  defaultAgent: "codex" as const,
  agentDefaults: {
    codex: { model: "custom-codex", effort: "xhigh" },
    claude: { model: "custom-claude", effort: "low" },
  },
});

beforeEach(() => {
  start.mockReset();
  send.mockReset();
  query.data = defaults();
  query.isError = false;
  useSessionsStore.setState({
    ...useSessionsStore.getInitialState(),
    start,
    send,
  });
  useUiStore.setState({ openSettings: vi.fn() });
});
afterEach(() => {
  useSessionsStore.setState(useSessionsStore.getInitialState(), true);
  useUiStore.setState(useUiStore.getInitialState(), true);
});

function submit() {
  fireEvent.change(
    screen.getByRole("textbox", { name: /(?:for|to) the agent/ }),
    {
      target: { value: "Implement the change" },
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

describe("Session composer defaults", () => {
  it("starts with the configured harness, model and effort", () => {
    render(<SessionComposer repoPath="/repo" session={null} />);
    expect(screen.getByLabelText("Model")).toHaveValue("custom-codex");
    expect(screen.getByLabelText("Thinking effort")).toHaveValue("xhigh");
    submit();
    expect(start).toHaveBeenCalledWith(
      "/repo",
      "Implement the change",
      "custom-codex",
      "codex",
      "xhigh",
      undefined,
      undefined,
      undefined,
    );
  });

  it("keeps an explicit account-default pick over configured values", () => {
    render(<SessionComposer repoPath="/repo" session={null} />);
    for (const label of ["Model", "Thinking effort"]) {
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: "custom-override" },
      });
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: "" },
      });
    }
    submit();
    expect(start.mock.calls[0].slice(2, 5)).toEqual(["", "codex", ""]);
  });

  it("follows settings while untouched and resolves defaults for a new harness", () => {
    const view = render(<SessionComposer repoPath="/repo" session={null} />);
    query.data = { ...defaults(), defaultAgent: "claude" };
    view.rerender(<SessionComposer repoPath="/repo" session={null} />);
    expect(screen.getByLabelText("Model")).toHaveValue("custom-claude");
    expect(screen.getByLabelText("Thinking effort")).toHaveValue("low");
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "chosen-claude" },
    });
    fireEvent.change(screen.getByLabelText("Thinking effort"), {
      target: { value: "medium" },
    });
    fireEvent.change(screen.getByLabelText("Harness"), {
      target: { value: "codex" },
    });
    expect(screen.getByLabelText("Model")).toHaveValue("custom-codex");
    expect(screen.getByLabelText("Thinking effort")).toHaveValue("xhigh");
  });

  it("keeps unpicked defaults live across a Settings round trip", () => {
    const view = render(<SessionComposer repoPath="/repo" session={null} />);
    fireEvent.click(screen.getByText("Settings round trip"));
    view.unmount();
    query.data = { ...defaults(), defaultAgent: "claude" };
    render(<SessionComposer repoPath="/repo" session={null} />);
    expect(screen.getByLabelText("Model")).toHaveValue("custom-claude");
    expect(screen.getByLabelText("Thinking effort")).toHaveValue("low");
  });

  it("restores explicit blank overrides for the same harness after Settings", () => {
    const view = render(<SessionComposer repoPath="/repo" session={null} />);
    for (const label of ["Model", "Thinking effort"]) {
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: "custom-override" },
      });
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: "" },
      });
    }
    fireEvent.click(screen.getByText("Settings round trip"));
    view.unmount();
    render(<SessionComposer repoPath="/repo" session={null} />);
    expect(screen.getByLabelText("Model")).toHaveValue("");
    expect(screen.getByLabelText("Thinking effort")).toHaveValue("");
  });

  it("keeps existing session choices and sends a continuing turn", () => {
    const session: AgentSession = {
      id: "ongoing",
      repoPath: "/repo",
      worktreePath: "/worktree",
      branch: "gd/session/ongoing",
      base: "base",
      headHash: "head",
      claudeSessionId: "native",
      model: "",
      effort: "",
      isolation: "worktree",
      agent: "claude",
      running: false,
      kept: false,
      turns: [],
    };
    render(<SessionComposer repoPath="/repo" session={session} />);
    expect(screen.getByLabelText("Model")).toHaveValue("");
    expect(screen.getByLabelText("Thinking effort")).toHaveValue("");
    submit();
    expect(start).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("ongoing", "Implement the change");
  });
});
