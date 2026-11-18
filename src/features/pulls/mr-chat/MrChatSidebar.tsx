import {
  CaretRightIcon,
  FilePlusIcon,
  SelectionIcon,
  StopIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type RefObject,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { usePanelActive } from "@/components/panel-portal";
import { PathText } from "@/components/path-text";
import { SelectClipText } from "@/components/select-clip-text";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  type AgentKind,
  agentDefaultsFor,
  defaultAgentKind,
} from "@/lib/ai/agent";
import {
  type AgentPermissionMode,
  agentPermissionOptions,
  defaultAgentPermission,
  isAgentPermissionMode,
} from "@/lib/ai/agent-permissions";
import { clipTitleFromText } from "@/lib/clip-title";
import type { PrSnapshotComparison } from "@/lib/git/api/pr-snapshot";
import { splitUnifiedDiff } from "@/lib/git/diff-split";
import { FULL_OID_RE } from "@/lib/git/oid";
import { normPath } from "@/lib/git/path";
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
  type MrChatFileContext,
  type MrChatSelectionRequest,
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
  selectionRequest?: MrChatSelectionRequest | null;
  onSelectionConsumed?: (id: string) => void;
  onOpenFile?: (reference: string) => void;
}

function comparisonFileContext(
  file: PaintedMrFile,
  comparison?: PrSnapshotComparison,
): MrChatFileContext | null {
  if (
    !comparison ||
    typeof comparison.baseSha !== "string" ||
    !FULL_OID_RE.test(comparison.baseSha) ||
    typeof comparison.headSha !== "string" ||
    !FULL_OID_RE.test(comparison.headSha) ||
    comparison.headSha.toLowerCase() !== file.headSha.toLowerCase() ||
    (comparison.oldPath !== null &&
      (typeof comparison.oldPath !== "string" || !comparison.oldPath)) ||
    (comparison.newPath !== null &&
      (typeof comparison.newPath !== "string" || !comparison.newPath)) ||
    (comparison.newPath ?? comparison.oldPath) !== file.lookupPath
  )
    return null;
  return {
    path: file.lookupPath,
    before: { path: comparison.oldPath, revision: comparison.baseSha },
    after: { path: comparison.newPath, revision: comparison.headSha },
  };
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
  selectionRequest,
  onSelectionConsumed,
  onOpenFile,
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
  const defaults = agentDefaultsFor(settings.data, agent);
  const [startModel, setStartModel] = useState<{
    agent: AgentKind;
    value: string;
  } | null>(null);
  const [startEffort, setStartEffort] = useState<{
    agent: AgentKind;
    value: string;
  } | null>(null);
  const model =
    session?.model ??
    (startModel?.agent === agent ? startModel.value : defaults.model);
  const effort =
    session?.effort ??
    (startEffort?.agent === agent ? startEffort.value : defaults.effort);
  const [startPermission, setStartPermission] = useState<{
    agent: AgentKind;
    mode: AgentPermissionMode;
  } | null>(null);
  const [preparingContext, setPreparingContext] = useState(false);
  const permissionMode = session
    ? isAgentPermissionMode(agent, session.permissionMode)
      ? session.permissionMode
      : defaultAgentPermission(agent, session.readOnly)
    : startPermission?.agent === agent
      ? startPermission.mode
      : defaultAgentPermission(agent);
  const permissionOptions = agentPermissionOptions(agent);
  const conversationItems = Object.fromEntries<string>([
    ["new", "New chat"],
    ...sessions.map((entry): [string, string] => [
      entry.id,
      `${AGENT_LABELS[entry.agent]} · ${entry.turns[0]?.prompt.split("\n")[0] ?? "Chat"}${entry.running ? " · Working…" : " · Awaiting input"}`,
    ]),
  ]);
  const permissionsLocked =
    !enabled ||
    !hydrated ||
    preparingContext ||
    Boolean(session?.running || session?.cancelling);
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
  const currentEnabled = useLatestRef(enabled);
  const currentHead = useLatestRef(context.headSha);
  const attachmentHead = useRef(context.headSha);
  const fileRead = useRef(0);
  const handledSelection = useRef<string | null>(null);
  const headingId = useId();
  const permissionsId = useId();
  const permissionsHintId = useId();
  const permissionOption = permissionOptions.find(
    (option) => option.value === permissionMode,
  );
  const permissionsHint = `${permissionOption?.label ?? "Permissions"}: ${permissionOption?.description ?? ""} Working checkout: ${context.repoPath}`;
  const code = useMrChatCodeContext(codeHostRef, context.headSha, enabled);
  const activeAttachments = attachments.filter(
    (attachment) => attachment.headSha === context.headSha,
  );
  const currentForm = useLatestRef({
    text: draft.value,
    sessionId: session?.id ?? null,
    agent,
    model,
    effort,
    permissionMode,
    attachmentIds: activeAttachments
      .map((attachment) => attachment.id)
      .join("|"),
  });

  useEffect(() => {
    live.current = true;
    setLoadingFile(false);
    setPreparingContext(false);
    return () => {
      live.current = false;
      fileRead.current++;
    };
  }, []);
  useEffect(() => {
    if (enabled) return;
    fileRead.current++;
    setLoadingFile(false);
    setPreparingContext(false);
  }, [enabled]);
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
    setPreparingContext(false);
    setAttachments([]);
    setAttachmentError(null);
  }, [context.headSha]);

  const focusComposer = () => composerRef.current?.focus();
  const chooseConversation = (id: string | null) => {
    setSelectedId(id);
    if (id === null) setStartPermission(null);
    setAttachments([]);
    setAttachmentError(null);
    fileRead.current++;
    setLoadingFile(false);
    setPreparingContext(false);
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
      lookupPath: file.lookupPath,
      relatedPaths: [comparison.oldPath, comparison.newPath].filter(
        (path): path is string => path !== null,
      ),
      side,
      text: decoded.text,
      format: "code",
      headSha: file.headSha,
      revision: side === "old" ? comparison.baseSha : comparison.headSha,
    };
  };
  const attachFile = async () => {
    const file = code.readFile();
    if (!currentEnabled.current || !file || loadingFile || preparingContext)
      return;
    const token = ++fileRead.current;
    setLoadingFile(true);
    setAttachmentError(null);
    const stillCurrent = () =>
      live.current &&
      currentEnabled.current &&
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
        if (!stillCurrent()) return;
        const decoded = decodePrFullFile(bytes);
        if (decoded.kind === "text" && decoded.text !== null)
          attachment = {
            id: crypto.randomUUID(),
            kind: "file",
            path: file.path,
            lookupPath: file.lookupPath,
            relatedPaths: file.relatedPaths,
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
          lookupPath: file.lookupPath,
          relatedPaths: file.relatedPaths,
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
  const verifySelection = (selection: MrChatAttachment) => {
    if (!context.headSha) return null;
    const lookupPath = selection.lookupPath ?? selection.path;
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
        selection.path,
        lens,
      ).queryKey,
    );
    const verified =
      (comparison &&
        verifiedMrSelection(
          selection,
          comparison,
          context.headSha,
          lookupPath,
        )) ||
      (source &&
        verifiedMrSourceSelection(
          selection,
          source,
          context.headSha,
          selection.path,
        ));
    return verified || null;
  };
  const attachSelection = () => {
    if (!code.selection) return;
    const verified = verifySelection(code.selection);
    if (verified) attach(verified);
    else
      setAttachmentError(
        "The selection does not match the current MR snapshot. Reload the file context and select its code again.",
      );
  };

  const applySelectionRequest = useEffectEvent(
    (request: MrChatSelectionRequest) => {
      if (
        mrChatKey(request.mr) !== mrChatKey(context.mr) ||
        normPath(request.repoPath) !== normPath(context.repoPath) ||
        request.headSha.toLowerCase() !== context.headSha?.toLowerCase()
      ) {
        setAttachmentError(
          "The selected code belongs to another MR snapshot. Select code in the current MR again.",
        );
      } else {
        const verified = verifySelection(request.selection);
        if (verified) attach(verified);
        else
          setAttachmentError(
            "The selection does not match the current MR snapshot. Reload the file context and select its code again.",
          );
      }
      onSelectionConsumed?.(request.id);
    },
  );
  useEffect(() => {
    if (
      !enabled ||
      !hydrated ||
      !selectionRequest ||
      handledSelection.current === selectionRequest.id
    )
      return;
    handledSelection.current = selectionRequest.id;
    applySelectionRequest(selectionRequest);
  }, [enabled, hydrated, selectionRequest]);

  const currentFileContext = async (
    file: PaintedMrFile,
  ): Promise<MrChatFileContext> => {
    const { before, after } = file.metadata;
    if (
      file.view === "source" &&
      after &&
      after.revision.toLowerCase() === file.headSha.toLowerCase() &&
      (after.path === file.lookupPath || after.path === null)
    )
      return { path: file.lookupPath, before: null, after };
    if (
      before &&
      after &&
      after.revision.toLowerCase() === file.headSha.toLowerCase() &&
      (after.path ?? before.path) === file.lookupPath
    )
      return { path: file.lookupPath, before, after };
    const options = prSnapshotComparisonOptions(
      context.repoPath,
      context.mr.number,
      file.headSha,
      file.lookupPath,
      lens,
    );
    const cached = comparisonFileContext(
      file,
      queryClient.getQueryData(options.queryKey),
    );
    if (cached) return cached;
    const comparison = await queryClient.fetchQuery({
      ...options,
      staleTime: 0,
    });
    const metadata = comparisonFileContext(file, comparison);
    if (!metadata)
      throw new Error(
        "The current file versions could not be verified. Reload the file and try again.",
      );
    return metadata;
  };

  const submit = async () => {
    const message = draft.value.trim();
    if (
      !enabled ||
      !hydrated ||
      !message ||
      session?.running ||
      session?.cancelling ||
      loadingFile ||
      preparingContext
    )
      return;
    const file = code.readFile();
    if (!file && code.hasPaintedFile()) {
      setAttachmentError(
        "The viewed file is still updating. Wait for it to finish before sending.",
      );
      return;
    }
    const captured = currentForm.current;
    const token = ++fileRead.current;
    setAttachmentError(null);
    if (file) setPreparingContext(true);
    try {
      const metadata = file ? await currentFileContext(file) : null;
      if (
        !live.current ||
        !currentEnabled.current ||
        fileRead.current !== token
      )
        return;
      const painted = code.readFile();
      if (
        file &&
        (!painted ||
          currentHead.current?.toLowerCase() !== file.headSha.toLowerCase() ||
          painted.lookupPath !== file.lookupPath ||
          painted.view !== file.view ||
          painted.headSha.toLowerCase() !== file.headSha.toLowerCase())
      )
        throw new Error(
          "The viewed file changed while its context loaded. Send again to use the current file.",
        );
      const latest = currentForm.current;
      if (
        Object.keys(captured).some(
          (key) =>
            captured[key as keyof typeof captured] !==
            latest[key as keyof typeof latest],
        )
      )
        throw new Error(
          "The draft changed while file context loaded. Send again when you are ready.",
        );
      const store = useMrChatStore.getState();
      if (session) {
        const liveSession = store.sessions.find(
          (entry) => entry.id === session.id,
        );
        if (!liveSession || liveSession.running || liveSession.cancelling)
          throw new Error(
            "Wait for the current chat response before sending again.",
          );
        store.send(session.id, context, message, activeAttachments, metadata);
      } else {
        const id = store.start(
          context,
          message,
          agent,
          model,
          effort,
          activeAttachments,
          permissionMode,
          metadata,
        );
        if (!id) return;
        setSelectedId(id);
      }
      draft.set("");
      setAttachments([]);
    } catch (error) {
      if (live.current && fileRead.current === token)
        setAttachmentError(errorMessage(error));
    } finally {
      if (live.current && fileRead.current === token)
        setPreparingContext(false);
    }
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
      : preparingContext
        ? "Preparing the current file's paths and revisions…"
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
          MR #{context.mr.number} · link at session start
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
          <p className="text-muted-foreground">{context.url}</p>
          <p className="mt-1 text-muted-foreground">
            The link is sent when a CLI session starts. The viewed file's path
            and before/after revisions accompany each message. Code is included
            only when attached; AI exclusions apply.
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
      <div className="flex min-w-0 items-center gap-1">
        <div className="min-w-0 flex-1">
          <ModelPicker
            value={model}
            agent={agent}
            active={enabled}
            className="w-full max-w-none min-w-0"
            onChange={(value) => {
              if (session)
                useMrChatStore.getState().setModel(session.id, context, value);
              else setStartModel({ agent, value });
            }}
          />
        </div>
        <EffortPicker
          value={effort}
          className="min-w-0 shrink-0"
          onChange={(value) => {
            if (session)
              useMrChatStore.getState().setEffort(session.id, context, value);
            else setStartEffort({ agent, value });
          }}
        />
        {session?.running ? (
          <Button
            size="sm"
            variant="outline"
            aria-label="Stop response"
            className="shrink-0"
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
            wrapperClassName="shrink-0"
            onClick={submit}
          >
            {preparingContext ? (
              <>
                <Spinner className="size-3" /> Preparing…
              </>
            ) : (
              "Send"
            )}
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
      <header className="shrink-0 border-b">
        <h2 id={headingId} className="sr-only">
          {AGENT_LABELS[agent]} chat
        </h2>
        <div className="flex min-h-10 min-w-0 items-center gap-1 px-2 py-1.5">
          <div className="shrink-0">
            {session ? (
              <span
                className="px-1 text-xs font-medium"
                title="Start a new chat to choose another harness"
              >
                {AGENT_LABELS[session.agent]}
              </span>
            ) : (
              <AgentPicker
                value={agent}
                onChange={(value) => {
                  setAgentPick(value);
                  setStartModel(null);
                  setStartEffort(null);
                  setStartPermission(null);
                }}
              />
            )}
          </div>
          <Label htmlFor={permissionsId} className="sr-only">
            Permissions
          </Label>
          <Select
            items={Object.fromEntries(
              permissionOptions.map((option) => [option.value, option.label]),
            )}
            value={permissionMode}
            disabled={permissionsLocked}
            onValueChange={(mode) => {
              if (permissionsLocked || !isAgentPermissionMode(agent, mode))
                return;
              if (session)
                useMrChatStore
                  .getState()
                  .setPermissionMode(session.id, context, mode);
              else setStartPermission({ agent, mode });
            }}
          >
            <SelectTrigger
              id={permissionsId}
              size="sm"
              aria-label="Permissions"
              aria-describedby={permissionsHintId}
              title={permissionsHint}
              className="w-auto max-w-24 min-w-0 shrink-0 border-0 px-1 text-muted-foreground shadow-none hover:bg-muted dark:bg-transparent"
            >
              <SelectValue
                className="min-w-0 truncate"
                onMouseEnter={clipTitleFromText}
              />
            </SelectTrigger>
            <SelectContent
              align="end"
              alignItemWithTrigger={false}
              className="w-auto min-w-(--anchor-width) max-w-[calc(100vw-2rem)]"
            >
              <SelectGroup>
                {permissionOptions.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={option.value}
                    aria-description={option.description}
                  >
                    <SelectClipText>{option.label}</SelectClipText>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {sessions.length > 0 && (
            <Select
              items={conversationItems}
              value={session?.id ?? "new"}
              onValueChange={(value) => {
                if (value === "new") newChat();
                else chooseConversation(value);
              }}
            >
              <SelectTrigger
                size="sm"
                aria-label="Ongoing MR chats"
                title={conversationItems[session?.id ?? "new"]}
                className="min-w-0 flex-1 border-0 px-1 text-muted-foreground shadow-none hover:bg-muted dark:bg-transparent"
              >
                <SelectValue
                  className="min-w-0 truncate"
                  onMouseEnter={clipTitleFromText}
                />
              </SelectTrigger>
              <SelectContent
                align="end"
                alignItemWithTrigger={false}
                className="w-auto min-w-(--anchor-width) max-w-[calc(100vw-2rem)]"
              >
                <SelectGroup>
                  {Object.entries(conversationItems).map(([id, label]) => (
                    <SelectItem
                      key={id}
                      value={id}
                      onClick={() => {
                        if (id === "new" && !session) newChat();
                      }}
                    >
                      <SelectClipText>{label}</SelectClipText>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
          {onCollapse && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Collapse MR chat"
              title="Collapse MR chat"
              className="ml-auto"
              onClick={onCollapse}
            >
              <CaretRightIcon />
            </Button>
          )}
          <span id={permissionsHintId} className="sr-only">
            {permissionsHint}
          </span>
        </div>
      </header>
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
          Ask about this MR or request a change. Attach the file you are viewing
          or select code to add context.
        </p>
      )}
      <SessionConversationView
        key={session?.id ?? "new"}
        turns={session?.turns ?? []}
        baseDir={context.repoPath}
        // MR chats have no checkpoint commits; finished turns say Completed
        // independently of the CLI's permission to edit the checkout.
        readOnly
        onOpenFile={onOpenFile}
        onEditResend={(prompt) => {
          draft.set(prompt);
          focusComposer();
        }}
        footer={footer}
      />
    </aside>
  );
}
