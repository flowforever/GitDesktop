import type { SessionTurn } from "@/features/sessions/store";
import { isAgentKind, type TranscriptSegment } from "@/lib/ai/agent";
import {
  agentPermissionReadOnly,
  defaultAgentPermission,
  isAgentPermissionMode,
} from "@/lib/ai/agent-permissions";
import { withAppStoreLock } from "@/lib/app-store-lock";
import {
  memoizedStoreLoader,
  reloadToleratingEmptyStore,
} from "@/lib/plugin-store";
import { writeWithRollback } from "@/lib/plugin-store-rollback";
import type { MrChatSession } from "./store";

const FILE = "mr-chats.json";
const getStore = memoizedStoreLoader(FILE);
let writes: Promise<unknown> = Promise.resolve();

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function segmentsOf(value: unknown): TranscriptSegment[] {
  if (!Array.isArray(value)) return [];
  const tools = new Set([
    "read",
    "search",
    "list",
    "edit",
    "write",
    "run",
    "web-fetch",
    "web-search",
    "task",
    "other",
  ]);
  return value.filter(
    (item): item is TranscriptSegment =>
      record(item) &&
      ((item.type === "text" && typeof item.text === "string") ||
        (item.type === "tool" &&
          typeof item.tool === "string" &&
          tools.has(item.tool) &&
          (item.target === null || typeof item.target === "string"))),
  );
}

function turnOf(value: unknown, interrupted: boolean): SessionTurn | null {
  if (
    !record(value) ||
    typeof value.prompt !== "string" ||
    typeof value.narration !== "string"
  )
    return null;
  const pending = value.status === "running" || value.status === "committing";
  if (!pending && value.status !== "done" && value.status !== "error")
    return null;
  return {
    prompt: value.prompt,
    narration: value.narration,
    status:
      pending && interrupted
        ? "error"
        : (value.status as SessionTurn["status"]),
    statusText: interrupted
      ? ""
      : typeof value.statusText === "string"
        ? value.statusText
        : "",
    segments: segmentsOf(value.segments),
    commitHash: null,
    costUsd:
      typeof value.costUsd === "number" && Number.isFinite(value.costUsd)
        ? value.costUsd
        : null,
    error:
      pending && interrupted
        ? "Interrupted by restart."
        : typeof value.error === "string"
          ? value.error
          : null,
  };
}

function sessionOf(value: unknown, interrupted: boolean): MrChatSession | null {
  if (!record(value) || !record(value.mr)) return null;
  const mr = value.mr;
  if (
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.repoPath !== "string" ||
    !value.repoPath ||
    typeof mr.host !== "string" ||
    !mr.host ||
    typeof mr.repoFullName !== "string" ||
    !mr.repoFullName ||
    typeof mr.number !== "number" ||
    !Number.isSafeInteger(mr.number) ||
    mr.number <= 0 ||
    !isAgentKind(value.agent) ||
    (value.state !== "active" && value.state !== "completed") ||
    !Array.isArray(value.turns)
  )
    return null;
  const turns = value.turns
    .map((turn) => turnOf(turn, interrupted))
    .filter((turn): turn is SessionTurn => turn !== null);
  const claudeSessionId =
    typeof value.claudeSessionId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.claudeSessionId,
    )
      ? value.claudeSessionId
      : undefined;
  const legacyReadOnly = Object.hasOwn(value, "readOnly")
    ? value.readOnly !== false
    : false;
  const permissionMode = Object.hasOwn(value, "permissionMode")
    ? isAgentPermissionMode(value.agent, value.permissionMode) &&
      (!legacyReadOnly || agentPermissionReadOnly(value.permissionMode))
      ? value.permissionMode
      : defaultAgentPermission(value.agent, true)
    : defaultAgentPermission(value.agent, legacyReadOnly);
  return {
    id: value.id,
    repoPath: value.repoPath,
    mr: {
      host: mr.host.toLowerCase(),
      repoFullName: mr.repoFullName,
      number: mr.number,
    },
    agent: value.agent,
    model: typeof value.model === "string" ? value.model : "",
    effort: typeof value.effort === "string" ? value.effort : "",
    readOnly: agentPermissionReadOnly(permissionMode),
    permissionMode,
    nativeSessionId:
      typeof value.nativeSessionId === "string" ? value.nativeSessionId : null,
    ...(claudeSessionId
      ? {
          claudeSessionId,
          claudeSessionReady: value.claudeSessionReady === true,
        }
      : {}),
    running: !interrupted && value.running === true,
    state: value.state,
    turns,
  };
}

function sessionsOf(value: unknown, interrupted: boolean): MrChatSession[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => sessionOf(item, interrupted))
    .filter((item): item is MrChatSession => item !== null);
}

function savedEntries(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new Error("Stored MR chats have an unreadable format.");
  return value;
}

export async function loadMrChats(): Promise<MrChatSession[]> {
  const store = await getStore();
  return sessionsOf(savedEntries(await store.get<unknown>("chats")), true);
}

/** Session UUIDs merge independently across windows; ended records remain durable
 * so another window's next write cannot resurrect them as ongoing chats. */
export function saveMrChats(sessions: MrChatSession[]): Promise<void> {
  const snapshot = structuredClone(sessions);
  const write = writes
    .catch(() => undefined)
    .then(async () => {
      const store = await getStore();
      await withAppStoreLock(FILE, async () => {
        await reloadToleratingEmptyStore(store);
        const merged = [...savedEntries(await store.get<unknown>("chats"))];
        for (const session of snapshot) {
          const index = merged.findIndex(
            (entry) => record(entry) && entry.id === session.id,
          );
          const previous = index >= 0 ? sessionOf(merged[index], false) : null;
          const next =
            previous?.state === "completed"
              ? { ...session, state: "completed", running: false }
              : session;
          if (index >= 0) merged[index] = next;
          else merged.push(next);
        }
        return writeWithRollback(store, async () => {
          await store.set("chats", merged);
          await store.save();
        });
      });
    });
  writes = write;
  return write;
}
