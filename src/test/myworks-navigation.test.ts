import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "@/lib/stores/ui";
import { documentId } from "@/lib/stores/work-documents";
import { installTransport } from "@/lib/transport";

const store = () => useUiStore.getState();
beforeEach(() => {
  useUiStore.setState(useUiStore.getInitialState(), true);
  installTransport({
    invoke: async <T>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      if (command === "validate_repo")
        return {
          root: args?.path,
          name: String(args?.path).split("/").pop(),
        } as T;
      if (command === "repo_origin_path")
        return {
          host: "git.test",
          authority: "git.test",
          path: `team/${String(args?.repoPath).split("/").pop()}`,
          provider: "gitlab",
        } as T;
      throw new Error(`Unexpected command ${command}`);
    },
  });
});

describe("My works home", () => {
  it("opens new verified MR documents without replacing a stack member's tab", async () => {
    const original = {
      host: "git.test",
      repoFullName: "team/a",
      number: 7,
      title: "Original member",
      repoPath: "/repos/a",
      repoName: "a",
    };
    store().openPr({
      kind: "remote",
      ref: "7",
      repoPath: original.repoPath,
      repoName: original.repoName,
      section: null,
      document: original,
    });
    const next = { ...original, number: 8, title: "Next member" };
    await store().activateWorkDocument(next);
    expect(store().workDocuments.documents.map((doc) => doc.number)).toEqual([
      7, 8,
    ]);
    expect(store().selectedPr?.id).toBe("8");
    await store().activateWorkDocument(next);
    expect(store().workDocuments.documents).toHaveLength(2);
    expect(store().workDocuments.documents[0].title).toBe("Original member");
  });

  it("starts at home and returns there after closing a repository", () => {
    expect(store().view).toBe("mywork");
    store().openRepo({ root: "/repos/a", name: "a" });
    store().closeRepo();
    expect(store().view).toBe("mywork");
  });

  it("returns from settings to home", () => {
    store().openMyWork();
    store().openSettings();
    store().closeSettings();
    expect(store().view).toBe("mywork");
  });

  it("opens, reuses and activates MR documents with their own repository context", async () => {
    const a = {
      host: "git.test",
      repoFullName: "team/a",
      number: 7,
      title: "First",
      repoPath: "/repos/a",
      repoName: "a",
    };
    const b = {
      ...a,
      repoFullName: "team/b",
      number: 9,
      title: "Second",
      repoPath: "/repos/b",
      repoName: "b",
    };
    const open = (document: typeof a) =>
      store().openPr({
        kind: "remote",
        ref: String(document.number),
        repoPath: document.repoPath,
        repoName: document.repoName,
        section: null,
        document,
      });
    open(a);
    open(b);
    open(a);
    expect(store().workDocuments.documents).toHaveLength(2);
    expect(store().selectedPr?.id).toBe("7");
    store().openMyWork();
    await store().activateWorkDocument(documentId(b));
    expect([store().repoPath, store().selectedPr?.id]).toEqual([
      "/repos/b",
      "9",
    ]);
    store().closeWorkDocument(documentId(a));
    expect(store().selectedPr?.id).toBe("9");
    store().closeWorkDocument(documentId(b));
    expect(store().view).toBe("mywork");
    expect(store().workDocuments.documents).toHaveLength(0);
  });

  it("refuses a cached MR checkout after its origin moves to another project", async () => {
    const document = {
      host: "git.test",
      repoFullName: "team/a",
      number: 7,
      title: "Original",
      repoPath: "/repos/a",
      repoName: "a",
    };
    store().openPr({
      kind: "remote",
      ref: "7",
      repoPath: document.repoPath,
      repoName: "a",
      section: null,
      document,
    });
    store().openMyWork();
    installTransport({
      invoke: async <T>(command: string): Promise<T> => {
        if (command === "validate_repo")
          return { root: "/repos/a", name: "a" } as T;
        if (command === "repo_origin_path")
          return {
            host: "git.test",
            authority: "git.test",
            path: "other/project",
            provider: "gitlab",
          } as T;
        throw new Error(`Unexpected command ${command}`);
      },
    });
    await store().activateWorkDocument(documentId(document));
    expect(store().view).toBe("mywork");
    expect(store().workDocuments.activeId).toBeNull();
    expect(store().workDocumentConnection?.document.repoFullName).toBe(
      "team/a",
    );
  });
});
