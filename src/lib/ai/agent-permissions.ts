import type { AgentKind } from "./agent";

export type AgentPermissionMode =
  | "read-only"
  | "auto"
  | "full-access"
  | "plan"
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "allow-tools";

interface PermissionOption {
  value: AgentPermissionMode;
  label: string;
  description: string;
}

const OPTIONS: Record<AgentKind, PermissionOption[]> = {
  codex: [
    {
      value: "read-only",
      label: "Read-only",
      description: "Inspect files without changing them.",
    },
    {
      value: "auto",
      label: "Auto",
      description: "Allow changes inside the current checkout.",
    },
    {
      value: "full-access",
      label: "Full Access",
      description: "Allow commands and file access beyond the checkout.",
    },
  ],
  claude: [
    {
      value: "plan",
      label: "Plan",
      description: "Inspect code with read-only tools.",
    },
    {
      value: "default",
      label: "Default",
      description:
        "Use Claude's configured approval rules; unapproved actions can be denied.",
    },
    {
      value: "acceptEdits",
      label: "Accept edits",
      description:
        "Approve file edits; other actions follow Claude's approval rules.",
    },
    {
      value: "auto",
      label: "Auto",
      description: "Let Claude evaluate and approve actions automatically.",
    },
    {
      value: "bypassPermissions",
      label: "Bypass permissions",
      description: "Allow the CLI's tools without permission prompts.",
    },
  ],
  copilot: [
    {
      value: "read-only",
      label: "Read-only",
      description: "Inspect files with writes and shell commands disabled.",
    },
    {
      value: "allow-tools",
      label: "Allow tools",
      description:
        "Approve tools with file access scoped to the current checkout.",
    },
    {
      value: "full-access",
      label: "Full Access",
      description: "Approve tools and file access beyond the checkout.",
    },
  ],
  opencode: [
    {
      value: "plan",
      label: "Plan",
      description: "Inspect code with read-only tools.",
    },
    {
      value: "default",
      label: "Default",
      description: "Use OpenCode's configured permission rules.",
    },
    {
      value: "auto",
      label: "Auto",
      description:
        "Approve permissions unless explicitly denied by OpenCode's rules.",
    },
  ],
};
const DEFAULTS: Record<AgentKind, AgentPermissionMode> = {
  codex: "auto",
  claude: "bypassPermissions",
  copilot: "allow-tools",
  opencode: "auto",
};

export const agentPermissionOptions = (
  agent: AgentKind,
): readonly PermissionOption[] => OPTIONS[agent];
export const agentPermissionReadOnly = (mode: AgentPermissionMode): boolean =>
  mode === "read-only" || mode === "plan";
export const defaultAgentPermission = (
  agent: AgentKind,
  readOnly = false,
): AgentPermissionMode =>
  readOnly ? OPTIONS[agent][0].value : DEFAULTS[agent];
export const isAgentPermissionMode = (
  agent: AgentKind,
  value: unknown,
): value is AgentPermissionMode =>
  OPTIONS[agent].some((option) => option.value === value);
