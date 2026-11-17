import type { MyWorkItem } from "@/lib/git/types/forge-repos";
import type { PrSection } from "@/lib/pulls/pr-section";
import type { UiState } from "@/lib/stores/ui";

export interface MrDocument {
  host: string;
  repoFullName: string;
  number: number;
  title: string;
  repoPath: string;
  repoName: string;
  url?: string;
  section?: PrSection;
  selectedPath?: string | null;
  selectedCommitOid?: string | null;
}

export interface WorkDocuments {
  documents: MrDocument[];
  repositories?: RepositoryDocument[];
  order?: string[];
  activeId: string | null;
}

const REPOSITORY_VIEW_FIELDS = [
  "repoTab",
  "compareBranch",
  "selectedPr",
  "selectedIssue",
  "selectedDiscussion",
  "selectedRunId",
  "selectedFinding",
  "findingsLimits",
  "selectedTag",
  "selectedTodo",
  "selectedFile",
  "selectedCommitHash",
  "compareCommitHash",
  "navHistory",
] as const;

export type RepositoryDocumentView = Pick<
  UiState,
  (typeof REPOSITORY_VIEW_FIELDS)[number]
>;

export interface RepositoryDocument {
  repoPath: string;
  repoName: string;
  viewState?: RepositoryDocumentView;
}

export type WorkDocumentTab =
  | { kind: "mr"; id: string; document: MrDocument }
  | { kind: "repository"; id: string; document: RepositoryDocument };

export const documentId = (
  doc: Pick<MrDocument, "host" | "repoFullName" | "number">,
) => JSON.stringify([doc.host.toLowerCase(), doc.repoFullName, doc.number]);

export const repositoryDocumentId = (
  document: Pick<RepositoryDocument, "repoPath">,
) => {
  // POSIX checkout paths keep their case. Windows drive and UNC roots accept
  // both separators and compare case-insensitively.
  const windows = /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(document.repoPath);
  const path = windows
    ? document.repoPath.replace(/\\/g, "/").toLowerCase()
    : document.repoPath;
  return JSON.stringify(["repository", path.replace(/\/+$/, "")]);
};

export function workDocumentTabs(state: WorkDocuments): WorkDocumentTab[] {
  const byId = new Map<string, WorkDocumentTab>();
  for (const document of state.documents) {
    const id = documentId(document);
    byId.set(id, { kind: "mr", id, document });
  }
  for (const document of state.repositories ?? []) {
    const id = repositoryDocumentId(document);
    byId.set(id, { kind: "repository", id, document });
  }
  const ordered: WorkDocumentTab[] = [];
  for (const id of state.order ?? []) {
    const tab = byId.get(id);
    if (tab) {
      ordered.push(tab);
      byId.delete(id);
    }
  }
  return [...ordered, ...byId.values()];
}

export function focusedRepositoryDocument(
  state: Pick<UiState, "view" | "repoPath" | "workDocuments">,
): string | null {
  if (state.view !== "repo" || state.repoPath === null) return null;
  const document = state.workDocuments.repositories?.find(
    (entry) => repositoryDocumentId(entry) === state.workDocuments.activeId,
  );
  return document &&
    repositoryDocumentId(document) ===
      repositoryDocumentId({ repoPath: state.repoPath })
    ? state.workDocuments.activeId
    : null;
}

export function rememberRepositoryDocument(state: UiState): WorkDocuments {
  const id = focusedRepositoryDocument(state);
  if (id === null) return state.workDocuments;
  const repository = state.workDocuments.repositories?.find(
    (document) => repositoryDocumentId(document) === id,
  );
  if (
    !repository ||
    (repository.viewState &&
      REPOSITORY_VIEW_FIELDS.every(
        (field) => repository.viewState?.[field] === state[field],
      ))
  )
    return state.workDocuments;
  const viewState = Object.fromEntries(
    REPOSITORY_VIEW_FIELDS.map((field) => [field, state[field]]),
  ) as RepositoryDocumentView;
  return {
    ...state.workDocuments,
    repositories: state.workDocuments.repositories?.map((document) =>
      repositoryDocumentId(document) === id
        ? { ...document, viewState }
        : document,
    ),
  };
}

export function openRepositoryDocument(
  state: WorkDocuments,
  document: RepositoryDocument,
): WorkDocuments {
  const id = repositoryDocumentId(document);
  const repositories = state.repositories ?? [];
  const found = repositories.some(
    (entry) => repositoryDocumentId(entry) === id,
  );
  const order = workDocumentTabs(state).map((tab) => tab.id);
  return {
    ...state,
    repositories: found
      ? repositories.map((entry) =>
          repositoryDocumentId(entry) === id
            ? { ...entry, ...document }
            : entry,
        )
      : [...repositories, document],
    order: found ? order : [...order, id],
    activeId: id,
  };
}

export function focusedWorkDocument(
  state: Pick<
    UiState,
    "view" | "repoTab" | "selectedPr" | "repoPath" | "workDocuments"
  >,
): string | null {
  if (
    state.view !== "repo" ||
    state.repoTab !== "pulls" ||
    state.selectedPr?.kind !== "remote"
  )
    return null;
  const document = state.workDocuments.documents.find(
    (entry) => documentId(entry) === state.workDocuments.activeId,
  );
  return document &&
    document.repoPath === state.repoPath &&
    String(document.number) === state.selectedPr.id
    ? state.workDocuments.activeId
    : null;
}

export function workItemFromDocument(doc: MrDocument): MyWorkItem {
  const parts = doc.repoFullName.split("/");
  return {
    provider: "gitlab",
    host: doc.host,
    number: doc.number,
    title: doc.title,
    repoFullName: doc.repoFullName,
    repoName: parts.at(-1) ?? doc.repoName,
    repoOwner: parts.at(-2) ?? "",
    isPullRequest: true,
    isDraft: false,
    updatedAt: "",
    url:
      doc.url ??
      `https://${doc.host}/${doc.repoFullName}/-/merge_requests/${doc.number}`,
  };
}

export function openDocument(
  state: WorkDocuments,
  doc: MrDocument,
): WorkDocuments {
  const id = documentId(doc);
  const found = state.documents.some((d) => documentId(d) === id);
  return {
    ...state,
    activeId: id,
    documents: found
      ? state.documents.map((d) =>
          documentId(d) === id ? { ...d, ...doc } : d,
        )
      : [...state.documents, doc],
    ...(state.order
      ? {
          order: found ? state.order : [...state.order, id],
        }
      : {}),
  };
}

export function closeDocument(state: WorkDocuments, id: string): WorkDocuments {
  const tabs = workDocumentTabs(state);
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const remaining = tabs.filter((tab) => tab.id !== id);
  const documents = state.documents.filter((d) => documentId(d) !== id);
  return {
    ...state,
    documents,
    ...(state.repositories
      ? {
          repositories: state.repositories.filter(
            (document) => repositoryDocumentId(document) !== id,
          ),
        }
      : {}),
    ...(state.order ? { order: remaining.map((tab) => tab.id) } : {}),
    activeId:
      state.activeId !== id
        ? state.activeId
        : remaining.length
          ? remaining[Math.min(index, remaining.length - 1)].id
          : null,
  };
}
