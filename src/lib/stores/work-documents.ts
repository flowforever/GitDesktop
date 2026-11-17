import type { MyWorkItem } from "@/lib/git/types/forge-repos";
import type { PrSection } from "@/lib/pulls/pr-section";

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
  activeId: string | null;
}

export const documentId = (
  doc: Pick<MrDocument, "host" | "repoFullName" | "number">,
) => JSON.stringify([doc.host.toLowerCase(), doc.repoFullName, doc.number]);

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
    activeId: id,
    documents: found
      ? state.documents.map((d) =>
          documentId(d) === id ? { ...d, ...doc } : d,
        )
      : [...state.documents, doc],
  };
}

export function closeDocument(state: WorkDocuments, id: string): WorkDocuments {
  const index = state.documents.findIndex((d) => documentId(d) === id);
  const documents = state.documents.filter((d) => documentId(d) !== id);
  return {
    documents,
    activeId:
      state.activeId !== id
        ? state.activeId
        : documents.length
          ? documentId(documents[Math.min(index, documents.length - 1)])
          : null,
  };
}
