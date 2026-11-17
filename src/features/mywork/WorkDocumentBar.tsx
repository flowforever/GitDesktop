import { XIcon } from "@phosphor-icons/react";
import { hasChordModifier } from "@/lib/hotkeys/binding";
import { hasMrTextDraft } from "@/lib/pulls/mr-document-drafts";
import { queryClient } from "@/lib/query-client";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";
import { documentId } from "@/lib/stores/work-documents";
import { cn } from "@/lib/utils";

export async function closeMrDocument(id: string) {
  const doc = useUiStore
    .getState()
    .workDocuments.documents.find((d) => documentId(d) === id);
  if (!doc) return;
  const reviews = queryClient.getQueryData<unknown[]>([
    "repo",
    doc.repoPath,
    "pr",
    "origin",
    doc.number,
    "review-drafts",
  ]);
  if (
    (hasMrTextDraft(doc) || (reviews?.length ?? 0) > 0) &&
    !(await useConfirm.getState().ask({
      title: "Close MR tab?",
      body: "This MR has an unfinished draft. Your draft is kept when you reopen it in this session.",
      confirmLabel: "Close tab",
      scope: "app",
    }))
  )
    return;
  useUiStore.getState().closeWorkDocument(id);
}

export function WorkDocumentBar() {
  const documents = useUiStore((s) => s.workDocuments.documents);
  const activeId = useUiStore((s) => s.workDocuments.activeId);
  const view = useUiStore((s) => s.view);
  const home = useUiStore((s) => s.openMyWork);
  const activate = useUiStore((s) => s.activateWorkDocument);
  const selected = view === "mywork" ? null : activeId;
  const ids = [null, ...documents.map(documentId)];
  return (
    <div
      role="tablist"
      aria-label="Work documents"
      className="flex shrink-0 overflow-x-auto border-b bg-muted/20"
      onKeyDown={(event) => {
        if (hasChordModifier(event)) return;
        if (
          !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) ||
          (event.target instanceof HTMLElement &&
            event.target.dataset.closeDocument !== undefined)
        )
          return;
        event.preventDefault();
        const index = Math.max(0, ids.indexOf(selected));
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? ids.length - 1
              : (index + (event.key === "ArrowRight" ? 1 : -1) + ids.length) %
                ids.length;
        const id = ids[next];
        if (id === null) home();
        else activate(id);
        document
          .getElementById(`work-tab-${encodeURIComponent(id ?? "home")}`)
          ?.focus();
      }}
    >
      <button
        type="button"
        role="tab"
        id="work-tab-home"
        aria-selected={selected === null}
        aria-controls="work-home-panel"
        tabIndex={selected === null ? 0 : -1}
        onClick={home}
        className={cn(
          "shrink-0 border-r px-4 py-2 text-xs focus-visible:outline-2 focus-visible:outline-ring",
          selected === null && "bg-background font-medium",
        )}
      >
        My works
      </button>
      {documents.map((doc) => {
        const id = documentId(doc);
        return (
          <div
            key={id}
            className={cn(
              "flex max-w-64 shrink-0 items-center border-r",
              selected === id && "bg-background",
            )}
          >
            <button
              type="button"
              role="tab"
              id={`work-tab-${encodeURIComponent(id)}`}
              aria-selected={selected === id}
              aria-controls={selected === id ? "work-mr-panel" : undefined}
              tabIndex={selected === id ? 0 : -1}
              onClick={() => activate(id)}
              title={`${doc.host}/${doc.repoFullName} !${doc.number}: ${doc.title}`}
              className="min-w-0 truncate px-3 py-2 text-xs focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="mr-2 font-mono text-muted-foreground">
                !{doc.number}
              </span>
              {doc.title}
            </button>
            <button
              type="button"
              data-close-document
              aria-label={`Close ${doc.repoFullName} !${doc.number}`}
              onClick={() => void closeMrDocument(id)}
              className="mr-1 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <XIcon className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
