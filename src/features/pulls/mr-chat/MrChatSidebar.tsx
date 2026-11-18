import {
  CaretRightIcon,
  ChatCircleIcon,
  FilePlusIcon,
  PlusIcon,
  SelectionIcon,
  StopIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { SelectControl } from "@/components/form/fields";
import { usePanelActive } from "@/components/panel-portal";
import { PathText } from "@/components/path-text";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { HighlightedCode } from "@/features/diff/HighlightedCode";
import {
  AGENT_LABELS,
  AgentPicker,
  EffortPicker,
  ModelPicker,
} from "@/features/sessions/AgentPickers";
import { SessionConversationView } from "@/features/sessions/SessionConversationView";
import { type AgentKind, defaultAgentKind } from "@/lib/ai/agent";
import { splitUnifiedDiff } from "@/lib/git/diff-split";
import {
  prSnapshotComparisonOptions,
  prSnapshotFileOptions,
} from "@/lib/git/queries/pr-snapshot";
import type { RemoteLens } from "@/lib/git/types";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { useMrTextDraft } from "@/lib/pulls/mr-document-drafts";
import { useSettings } from "@/lib/settings/queries";
import { errorMessage } from "@/lib/tauri/invoke";
import { useLatestRef } from "@/lib/use-latest-ref";
import { buildPrSnapshotContext, decodePrFullFile } from "../pr-full-context";
import { verifiedMrSelection, verifiedMrSourceSelection } from "./attachments";
import {
  type MrChatAttachment,
  type MrChatContext,
  mrChatKey,
} from "./context";
import { matchesMrChat, useMrChatStore } from "./store";
import {
  type PaintedMrFile,
  useMrChatCodeContext,
} from "./useMrChatCodeContext";

interface MrChatSidebarProps {
  context: MrChatContext;
  lens: RemoteLens;
  codeHostRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  onCollapse?: () => void;
}

export function MrChatSidebar(props: MrChatSidebarProps) {
  return (
    <ScopedMrChat
      key={JSON.stringify([
        props.context.repoPath,
        mrChatKey(props.context.mr),
      ])}
      {...props}
    />
  );
}

function ScopedMrChat({
  context,
  lens,
  codeHostRef,
  enabled: interactive,
  onCollapse,
}: MrChatSidebarProps) {
  const panelActive = usePanelActive();
  const enabled = interactive && panelActive;
  const queryClient = useQueryClient();
  const settings = useSettings();
  const allSessions = useMrChatStore((state) => state.sessions);
  const hydrated = useMrChatStore((state) => state.hydrated);
  const sessions = allSessions.filter((session) =>
    matchesMrChat(session, context),
  );
  const [selectedId, setSelectedId] = useState<string | null | undefined>(
    undefined,
  );
  const session =
    selectedId === undefined
      ? sessions.at(-1)
      : sessions.find((entry) => entry.id === selectedId);
  const [agentPick, setAgentPick] = useState<AgentKind | null>(null);
  const agent = session?.agent ?? agentPick ?? defaultAgentKind(settings.data);
  const [startModel, setStartModel] = useState("");
  const [modelAgent, setModelAgent] = useState<AgentKind | null>(null);
  const [startEffort, setStartEffort] = useState("");
  const model = session?.model ?? (modelAgent === agent ? startModel : "");
  const effort = session?.effort ?? startEffort;
  const draft = useMrTextDraft(
    `${mrChatKey(context.mr)}|chat|${context.repoPath}|${session?.id ?? "new"}`,
  );
  const [attachments, setAttachments] = useState<MrChatAttachment[]>([]);
  const [loadingFile, setLoadingFile] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [showContext, setShowContext] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const live = useRef(true);
  const currentHead = useLatestRef(context.headSha);
  const attachmentHead = useRef(context.headSha);
  const fileRead = useRef(0);
  const headingId = useId();
  const code = useMrChatCodeContext(codeHostRef, context.headSha, enabled);
  const activeAttachments = attachments.filter(
    (attachment) => attachment.headSha === context.headSha,
  );

  useEffect(() => {
    live.current = true;
    setLoadingFile(false);
    return () => {
      live.current = false;
      fileRead.current++;
    };
  }, []);
  useEffect(() => {
    void useMrChatStore
      .getState()
      .hydrate()
      .catch((error) => {
        if (live.current) setLoadError(errorMessage(error));
      });
  }, []);
  useEffect(() => {
    if (attachmentHead.current === context.headSha) return;
    attachmentHead.current = context.headSha;
    fileRead.current++;
    setLoadingFile(false);
    setAttachments([]);
    setAttachmentError(null);
  }, [context.headSha]);

  const focusComposer = () => composerRef.current?.focus();
  const chooseConversation = (id: string | null) => {
    setSelectedId(id);
    setAttachments([]);
    setAttachmentError(null);
    fileRead.current++;
    setLoadingFile(false);
  };
  const newChat = () => {
    chooseConversation(null);
    requestAnimationFrame(focusComposer);
  };
  const attach = (attachment: MrChatAttachment) => {
    setAttachments((previous) => [
      ...previous.filter(
        (entry) =>
          !(
            entry.kind === attachment.kind &&
            entry.path === attachment.path &&
            entry.side === attachment.side &&
            entry.startLine === attachment.startLine &&
            entry.endLine === attachment.endLine
          ),
      ),
      attachment,
    ]);
    setAttachmentError(null);
  };
  const fromComparison = (file: PaintedMrFile): MrChatAttachment | null => {
    const options = prSnapshotComparisonOptions(
      context.repoPath,
      context.mr.number,
      file.headSha,
      file.lookupPath,
      lens,
    );
    const comparison = queryClient.getQueryData(options.queryKey);
    if (
      !comparison ||
      buildPrSnapshotContext(comparison, file.lookupPath, file.headSha).kind !==
        "ready"
    )
      return null;
    const side =
      file.side === "old" || comparison.newPath === null ? "old" : "new";
    const bytes = side === "old" ? comparison.before : comparison.after;
    const decoded = decodePrFullFile(bytes);
    const path = side === "old" ? comparison.oldPath : comparison.newPath;
    if (decoded.kind !== "text" || decoded.text === null || path === null)
      return null;
    return {
      id: crypto.randomUUID(),
      kind: "file",
      path,
      side,
      text: decoded.text,
      format: "code",
      headSha: file.headSha,
      revision: side === "old" ? comparison.baseSha : comparison.headSha,
    };
  };
  const attachFile = async () => {
    const file = code.readFile();
    if (!file || loadingFile) return;
    const token = ++fileRead.current;
    setLoadingFile(true);
    setAttachmentError(null);
    const stillCurrent = () =>
      live.current &&
      fileRead.current === token &&
      currentHead.current === file.headSha;
    try {
      let attachment = fromComparison(file);
      if (!attachment && file.side === "new") {
        const bytes = await queryClient.fetchQuery(
          prSnapshotFileOptions(
            context.repoPath,
            file.headSha,
            file.path,
            lens,
          ),
        );
        const decoded = decodePrFullFile(bytes);
        if (decoded.kind === "text" && decoded.text !== null)
          attachment = {
            id: crypto.randomUUID(),
            kind: "file",
            path: file.path,
            side: "new",
            text: decoded.text,
            format: "code",
            revision: file.headSha,
            headSha: file.headSha,
          };
      }
      if (!attachment) {
        await queryClient.fetchQuery(
          prSnapshotComparisonOptions(
            context.repoPath,
            context.mr.number,
            file.headSha,
            file.lookupPath,
            lens,
          ),
        );
        attachment = fromComparison(file);
      }
      if (!stillCurrent()) return;
      if (!attachment) throw new Error("Full file source is unavailable.");
      attach(attachment);
    } catch (error) {
      if (!stillCurrent()) return;
      const patch = splitUnifiedDiff(context.diff ?? "").get(file.lookupPath);
      if (patch)
        attach({
          id: crypto.randomUUID(),
          kind: "file",
          path: file.path,
          side: file.side,
          text: patch,
          format: "diff",
          headSha: file.headSha,
        });
      else setAttachmentError(errorMessage(error));
    } finally {
      if (stillCurrent()) setLoadingFile(false);
    }
  };
  const attachSelection = () => {
    if (!code.selection || !context.headSha) return;
    const lookupPath = code.selection.lookupPath ?? code.selection.path;
    const comparison = queryClient.getQueryData(
      prSnapshotComparisonOptions(
        context.repoPath,
        context.mr.number,
        context.headSha,
        lookupPath,
        lens,
      ).queryKey,
    );
    const source = queryClient.getQueryData(
      prSnapshotFileOptions(
        context.repoPath,
        context.headSha,
        code.selection.path,
        lens,
      ).queryKey,
    );
    const verified =
      (comparison &&
        verifiedMrSelection(
          code.selection,
          comparison,
          context.headSha,
          lookupPath,
        )) ||
      (source &&
        verifiedMrSourceSelection(
          code.selection,
          source,
          context.headSha,
          code.selection.path,
        ));
    if (verified) attach(verified);
    else
      setAttachmentError(
        "The selection does not match the current MR snapshot. Reload the file context and select its code again.",
      );
  };
  const submit = () => {
    const message = draft.value.trim();
    if (!enabled || !hydrated || !message || session?.running || loadingFile)
      return;
    const store = useMrChatStore.getState();
    if (session) store.send(session.id, context, message, activeAttachments);
    else {
      const id = store.start(
        context,
        message,
        agent,
        model,
        effort,
        activeAttachments,
      );
      if (!id) return;
      setSelectedId(id);
    }
    draft.set("");
    setAttachments([]);
  };
  useHotkeyAction("mr-chat-focus", focusComposer, enabled);
  useHotkeyAction("mr-chat-new", newChat, enabled);
  useHotkeyAction(
    "mr-chat-attach-file",
    () => void attachFile(),
    enabled && code.file !== null && !loadingFile,
  );
  useHotkeyAction(
    "mr-chat-attach-selection",
    attachSelection,
    enabled && code.selection !== null,
  );
  const pendingReason = !enabled
    ? "Wait for the current MR to finish loading."
    : !hydrated
      ? "Wait for saved MR chats to load."
      : loadingFile
        ? "Wait for the file attachment to load."
        : !draft.value.trim()
          ? "Type a message about this MR."
          : session?.running
            ? "Wait for the agent, or stop its current response."
            : null;

  const footer = (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1">
        <Button
          size="xs"
          variant="outline"
          aria-expanded={showContext}
          onClick={() => setShowContext((value) => !value)}
        >
          MR #{context.mr.number} · always included
        </Button>
        <DisabledReasonButton
          size="icon-xs"
          variant="ghost"
          aria-label="Attach current file"
          title="Attach current file"
          disabled={!enabled || !code.file || loadingFile}
          reason={
            loadingFile
              ? "Loading the file snapshot…"
              : "Open a file at the current MR head to attach it."
          }
          onClick={() => void attachFile()}
        >
          {loadingFile ? <Spinner className="size-3.5" /> : <FilePlusIcon />}
        </DisabledReasonButton>
        <DisabledReasonButton
          size="icon-xs"
          variant="ghost"
          aria-label="Attach selected code"
          title="Attach selected code"
          disabled={!enabled || !code.selection}
          reason="Select code on one side of the current MR file."
          onMouseDown={(event) => event.preventDefault()}
          onClick={attachSelection}
        >
          <SelectionIcon />
        </DisabledReasonButton>
      </div>
      {showContext && (
        <div className="max-h-40 overflow-auto border bg-muted/30 p-2 text-[11px] break-words whitespace-pre-wrap">
          <p className="font-medium">{context.title}</p>
          <p className="text-muted-foreground">{context.url}</p>
          <p>
            {context.headRefName} → {context.baseRefName}
          </p>
          <p>{context.body}</p>
          <p className="mt-1 text-muted-foreground">
            Description, branches, changed files and MR diff accompany every
            message. AI exclusions apply.
          </p>
        </div>
      )}
      {activeAttachments.map((attachment) => (
        <div
          key={attachment.id}
          className="flex items-start gap-1 border px-2 py-1 text-[11px]"
        >
          <details className="min-w-0 flex-1">
            <summary className="cursor-pointer">
              <span className="inline-flex max-w-full items-center gap-1 align-middle">
                <PathText path={attachment.path} />
                <span className="shrink-0 text-muted-foreground">
                  {attachment.format === "diff"
                    ? "patch"
                    : attachment.kind === "selection"
                      ? `${attachment.side}:${attachment.startLine}–${attachment.endLine}`
                      : "full file"}
                </span>
              </span>
            </summary>
            <div className="mt-1 max-h-36 overflow-auto">
              <HighlightedCode
                path={
                  attachment.format === "diff"
                    ? "attachment.diff"
                    : attachment.path
                }
                content={attachment.text.slice(0, 8_000)}
              />
            </div>
            {attachment.text.length > 8_000 && (
              <p className="text-muted-foreground">
                Preview shortened; the attachment is included up to the context
                limit.
              </p>
            )}
          </details>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove ${attachment.path}`}
            title="Remove attachment"
            onClick={() =>
              setAttachments((previous) =>
                previous.filter((entry) => entry.id !== attachment.id),
              )
            }
          >
            <XIcon />
          </Button>
        </div>
      ))}
      {attachmentError && (
        <p role="alert" className="text-[11px] text-destructive">
          {attachmentError}
        </p>
      )}
      <textarea
        ref={composerRef}
        aria-label="Message about this MR"
        placeholder="Ask about this MR…"
        value={draft.value}
        readOnly={!enabled || !hydrated}
        onChange={(event) => draft.set(event.target.value)}
        rows={3}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            submit();
          }
        }}
        className="max-h-40 min-h-20 w-full resize-y border border-input bg-transparent px-2 py-1.5 text-xs leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50"
      />
      <div className="flex flex-wrap items-center gap-1">
        {session ? (
          <span className="px-1 text-[11px] text-muted-foreground">
            {AGENT_LABELS[session.agent]}
          </span>
        ) : (
          <AgentPicker
            value={agent}
            onChange={(value) => {
              setAgentPick(value);
              setStartModel("");
              setModelAgent(null);
            }}
          />
        )}
        <ModelPicker
          value={model}
          agent={agent}
          active={enabled}
          onChange={(value) => {
            if (session)
              useMrChatStore.getState().setModel(session.id, context, value);
            else {
              setStartModel(value);
              setModelAgent(agent);
            }
          }}
        />
        <EffortPicker
          value={effort}
          onChange={(value) => {
            if (session)
              useMrChatStore.getState().setEffort(session.id, context, value);
            else setStartEffort(value);
          }}
        />
        <div className="flex-1" />
        {session?.running ? (
          <Button
            size="sm"
            variant="outline"
            aria-label="Stop response"
            onClick={() =>
              useMrChatStore.getState().cancel(session.id, context)
            }
          >
            <StopIcon data-icon="inline-start" /> Stop
          </Button>
        ) : (
          <DisabledReasonButton
            size="sm"
            aria-label="Send message"
            disabled={pendingReason !== null}
            reason={pendingReason}
            onClick={submit}
          >
            Send
          </DisabledReasonButton>
        )}
      </div>
    </div>
  );
  return (
    <aside
      aria-labelledby={headingId}
      className="ph-no-capture flex h-full min-h-0 w-full min-w-0 flex-col border-l bg-background"
    >
      <header className="flex min-h-10 shrink-0 items-center gap-2 border-b px-3 py-2">
        <ChatCircleIcon className="size-4 text-primary" aria-hidden />
        <h2 id={headingId} className="flex-1 text-xs font-medium">
          MR chat
        </h2>
        <span className="text-[10px] text-muted-foreground">Read-only</span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="New chat"
          title="New chat"
          onClick={newChat}
        >
          <PlusIcon />
        </Button>
        {onCollapse && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Collapse MR chat"
            title="Collapse MR chat"
            onClick={onCollapse}
          >
            <CaretRightIcon />
          </Button>
        )}
      </header>
      {sessions.length > 0 && (
        <div className="flex shrink-0 items-end gap-2 border-b px-3 py-2">
          <div className="min-w-0 flex-1">
            <SelectControl
              label="Ongoing MR chats"
              items={Object.fromEntries([
                ["new", "New chat"],
                ...sessions.map((entry) => [
                  entry.id,
                  `${AGENT_LABELS[entry.agent]} · ${entry.turns[0]?.prompt.split("\n")[0] ?? "Chat"}${entry.running ? " · Working…" : " · Awaiting input"}`,
                ]),
              ])}
              value={session?.id ?? "new"}
              onValueChange={(value) =>
                chooseConversation(value === "new" ? null : value)
              }
              sizeToContent
            />
          </div>
          {session && (
            <DisabledReasonButton
              variant="ghost"
              size="xs"
              disabled={session.running}
              reason="Stop the current response before ending this chat."
              onClick={() => {
                draft.set("");
                useMrChatStore.getState().complete(session.id, context);
                newChat();
              }}
            >
              End chat
            </DisabledReasonButton>
          )}
        </div>
      )}
      {!hydrated && !loadError ? (
        <div
          role="status"
          aria-label="Loading MR chats"
          className="space-y-2 p-3"
        >
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : null}
      {loadError && (
        <div role="alert" className="border-b p-3 text-[11px] text-destructive">
          {loadError}
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void useMrChatStore
                .getState()
                .hydrate()
                .then(() => setLoadError(null))
                .catch((error) => setLoadError(errorMessage(error)))
            }
          >
            Retry loading chats
          </Button>
        </div>
      )}
      {!session && (
        <p className="px-4 pt-4 text-xs leading-relaxed text-muted-foreground">
          Ask about this MR with your CLI. Attach the file you are viewing or
          select code to add a focused excerpt.
        </p>
      )}
      <SessionConversationView
        key={session?.id ?? "new"}
        turns={session?.turns ?? []}
        baseDir={context.repoPath}
        readOnly
        onEditResend={(prompt) => {
          draft.set(prompt);
          focusComposer();
        }}
        footer={footer}
      />
    </aside>
  );
}
