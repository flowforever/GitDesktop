import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { SessionComposer, type SessionComposerHandle } from "./SessionComposer";
import { SessionConversationView } from "./SessionConversationView";
import { type AgentSession, useSessionsStore } from "./store";

export function SessionConversation({
  session,
  repoPath,
  terminalOpen,
}: {
  session: AgentSession;
  repoPath: string;
  terminalOpen: boolean;
}) {
  const resume = useSessionsStore((state) => state.resume);
  const busy = useSessionsStore((state) => state.busyId === session.id);
  const composerRef = useRef<SessionComposerHandle>(null);
  return (
    <SessionConversationView
      turns={session.turns}
      baseDir={session.kept ? session.repoPath : session.worktreePath}
      editDiffBase={session.kept ? undefined : session.base}
      editDiffLive={session.running}
      resendable={!session.kept}
      onEditResend={(prompt) => composerRef.current?.setPrompt(prompt)}
      terminalOpen={terminalOpen}
      footer={
        session.kept ? (
          <div className="flex items-center gap-2 px-1 py-1">
            <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">
              Kept on <span className="font-mono">{session.branch}</span> —
              resume to continue the conversation.
            </span>
            <Button
              size="sm"
              className="shrink-0"
              disabled={busy}
              onClick={() => resume(session.id)}
            >
              Resume
            </Button>
          </div>
        ) : (
          <SessionComposer
            repoPath={repoPath}
            session={session}
            handleRef={composerRef}
          />
        )
      }
    />
  );
}
