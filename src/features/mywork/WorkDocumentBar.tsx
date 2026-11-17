import { FolderIcon, XIcon } from "@phosphor-icons/react";
import { hasChordModifier } from "@/lib/hotkeys/binding";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { hasMrTextDraft } from "@/lib/pulls/mr-document-drafts";
import { queryClient } from "@/lib/query-client";
import { useConfirm } from "@/lib/stores/confirm";
import { type UiState, useUiStore } from "@/lib/stores/ui";
import {
  documentId,
  focusedRepositoryDocument,
  focusedWorkDocument,
  type WorkDocuments,
  workDocumentTabs,
} from "@/lib/stores/work-documents";
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

export async function closeDocumentTab(id: string) {
  if (
    useUiStore
      .getState()
      .workDocuments.documents.some((document) => documentId(document) === id)
  )
    await closeMrDocument(id);
  else useUiStore.getState().closeWorkDocument(id);
}

const FIXED_TABS = [
  { id: "home", label: "My works", panel: "work-home-panel" },
  {
    id: "repositories",
    label: "Repositories",
    panel: "work-repositories-panel",
  },
];

const workTabIds = (documents: WorkDocuments) => [
  ...FIXED_TABS.map((tab) => tab.id),
  ...workDocumentTabs(documents).map((tab) => tab.id),
];

function selectedWorkTab(state: UiState): string {
  return state.view === "mywork"
    ? "home"
    : (focusedWorkDocument(state) ??
        focusedRepositoryDocument(state) ??
        "repositories");
}

function activateWorkTab(id: string) {
  const state = useUiStore.getState();
  if (id === "home") state.openMyWork();
  else if (id === "repositories") state.openRepositories();
  else void state.activateWorkDocument(id);
}

function cycleWorkTab(direction: 1 | -1) {
  const state = useUiStore.getState();
  const ids = workTabIds(state.workDocuments);
  const index = Math.max(0, ids.indexOf(selectedWorkTab(state)));
  activateWorkTab(ids[(index + direction + ids.length) % ids.length]);
}

export function useWorkTabNavigation(enabled: boolean) {
  useHotkeyAction("work-next-document", () => cycleWorkTab(1), enabled);
  useHotkeyAction("work-previous-document", () => cycleWorkTab(-1), enabled);
}

export function WorkDocumentBar() {
  const documents = useUiStore((state) => state.workDocuments);
  const selected = useUiStore(selectedWorkTab);
  const ids = workTabIds(documents);
  const tabs = workDocumentTabs(documents);

  return (
    <div
      role="tablist"
      aria-label="Work documents"
      className="flex min-w-0 shrink-0 border-b bg-muted/20"
      onKeyDown={(event) => {
        if (hasChordModifier(event)) return;
        if (
          !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) ||
          (event.target instanceof HTMLElement &&
            event.target.dataset.closeDocument !== undefined)
        )
          return;
        event.preventDefault();
        const focused =
          event.target instanceof HTMLElement
            ? event.target
                .closest("[data-work-tab]")
                ?.getAttribute("data-work-tab")
            : null;
        const index = Math.max(0, ids.indexOf(focused ?? selected));
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? ids.length - 1
              : (index + (event.key === "ArrowRight" ? 1 : -1) + ids.length) %
                ids.length;
        const id = ids[next];
        activateWorkTab(id);
        document.getElementById(`work-tab-${encodeURIComponent(id)}`)?.focus();
      }}
    >
      {FIXED_TABS.map(({ id, label, panel }) => (
        <button
          key={id}
          type="button"
          role="tab"
          id={`work-tab-${id}`}
          data-work-tab={id}
          aria-selected={selected === id}
          aria-controls={id === "home" || selected === id ? panel : undefined}
          tabIndex={selected === id ? 0 : -1}
          onClick={() => activateWorkTab(id)}
          className={cn(
            "shrink-0 border-r px-4 py-2 text-xs focus-visible:outline-2 focus-visible:outline-ring",
            selected === id && "bg-background font-medium",
          )}
        >
          {label}
        </button>
      ))}
      <div className="flex min-w-0 flex-1 overflow-x-auto">
        {tabs.map((tab) => {
          const { id } = tab;
          const title =
            tab.kind === "repository"
              ? tab.document.repoName
              : tab.document.title;
          const tooltip =
            tab.kind === "repository"
              ? tab.document.repoPath
              : `${tab.document.host}/${tab.document.repoFullName} !${tab.document.number}: ${tab.document.title}`;
          const closeLabel =
            tab.kind === "repository"
              ? `Close repository ${tab.document.repoName}`
              : `Close ${tab.document.repoFullName} !${tab.document.number}`;
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
                data-work-tab={id}
                aria-selected={selected === id}
                aria-controls={
                  selected === id
                    ? tab.kind === "repository"
                      ? "work-repository-panel"
                      : "work-mr-panel"
                    : undefined
                }
                tabIndex={selected === id ? 0 : -1}
                onClick={() => activateWorkTab(id)}
                title={tooltip}
                className="min-w-0 truncate px-3 py-2 text-xs focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span className="mr-2 font-mono text-muted-foreground">
                  {tab.kind === "repository" ? (
                    <FolderIcon aria-hidden className="inline-block size-3" />
                  ) : (
                    <>!{tab.document.number}</>
                  )}
                </span>
                {title}
              </button>
              <button
                type="button"
                data-close-document
                aria-label={closeLabel}
                onClick={() => void closeDocumentTab(id)}
                className="mr-1 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              >
                <XIcon className="size-3" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
