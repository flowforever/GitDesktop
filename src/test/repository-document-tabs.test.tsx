import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkDocumentBar } from "@/features/mywork/WorkDocumentBar";
import { repoOriginPath, validateRepo } from "@/lib/git/api/repo";
import type { RepoInfo } from "@/lib/git/types";
import { useUiStore } from "@/lib/stores/ui";

vi.mock("@/lib/git/api/repo", async (original) => ({
  ...(await original<typeof import("@/lib/git/api/repo")>()),
  validateRepo: vi.fn(),
  repoOriginPath: vi.fn(),
}));

const ALPHA = { root: "/repos/alpha", name: "alpha" };
const BRAVO = { root: "/repos/bravo", name: "bravo" };
const MR = {
  host: "git.test",
  repoFullName: "team/mr",
  number: 7,
  title: "Review the merge request",
  repoPath: "/repos/mr",
  repoName: "mr",
};
const store = () => useUiStore.getState();
const tab = (name: string | RegExp) => screen.getByRole("tab", { name });

function openMr() {
  store().openPr({
    kind: "remote",
    ref: "7",
    repoPath: MR.repoPath,
    repoName: MR.repoName,
    section: "conversation",
    document: MR,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState(useUiStore.getInitialState(), true);
  vi.mocked(validateRepo).mockImplementation(async (path) => ({
    root: path,
    name: path.split("/").at(-1) ?? path,
  }));
  vi.mocked(repoOriginPath).mockResolvedValue({
    host: MR.host,
    authority: MR.host,
    path: MR.repoFullName,
    provider: "gitlab",
  });
});

describe("repository document tabs", () => {
  it("opens and reuses a closable tab for each chosen checkout", async () => {
    const user = userEvent.setup();
    store().openRepo(ALPHA);
    render(<WorkDocumentBar />);

    expect(tab("alpha")).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("button", { name: "Close repository alpha" }),
    ).toBeVisible();
    await user.click(tab("Repositories"));
    expect(tab("alpha")).toBeVisible();
    expect(store().view).toBe("welcome");

    act(() => store().openRepo(BRAVO));
    expect(tab("bravo")).toHaveAttribute("aria-selected", "true");
    act(() => store().openRepo(ALPHA));

    expect(screen.getAllByRole("tab").map((item) => item.textContent)).toEqual([
      "My works",
      "Repositories",
      "alpha",
      "bravo",
    ]);
    expect(tab("alpha")).toHaveAttribute("aria-selected", "true");
    expect(store().repoPath).toBe("/repos/alpha");
  });

  it.each([
    ["drive", "C:\\repos\\alpha", "c:/repos/ALPHA"],
    ["UNC", "\\\\Server\\Share\\alpha", "//server/share/ALPHA"],
  ])(
    "deduplicates equivalent Windows %s checkout paths",
    (_kind, first, second) => {
      store().openRepo({ root: first, name: "alpha" });
      store().openRepo({ root: second, name: "alpha" });
      render(<WorkDocumentBar />);

      expect(screen.getAllByRole("tab")).toHaveLength(3);
      expect(tab("alpha")).toHaveAttribute("aria-selected", "true");
    },
  );

  it("keeps case-distinct POSIX checkouts and their selections separate", async () => {
    const user = userEvent.setup();
    store().openRepo({ root: "/repos/Alpha", name: "Alpha" });
    store().setRepoTab("history");
    store().selectCommit("upper-commit");
    store().openRepo(ALPHA);

    expect(store().repoTab).toBe("changes");
    expect(store().selectedCommitHash).toBeNull();
    store().setRepoTab("pulls");
    store().selectPr({ kind: "remote", id: "22" });
    render(<WorkDocumentBar />);

    expect(screen.getAllByRole("tab")).toHaveLength(4);
    await user.click(tab("Alpha"));
    await waitFor(() => expect(store().repoPath).toBe("/repos/Alpha"));
    expect(tab("Alpha")).toHaveAttribute("aria-selected", "true");
    expect(store().repoTab).toBe("history");
    expect(store().selectedCommitHash).toBe("upper-commit");
    expect(store().selectedPr).toBeNull();

    await user.click(tab("alpha"));
    await waitFor(() => expect(store().repoPath).toBe("/repos/alpha"));
    expect(tab("alpha")).toHaveAttribute("aria-selected", "true");
    expect(store().repoTab).toBe("pulls");
    expect(store().selectedPr).toEqual({ kind: "remote", id: "22" });
    expect(store().selectedCommitHash).toBeNull();
  });

  it("does not record a case-distinct POSIX navigation into another tab", async () => {
    const user = userEvent.setup();
    store().openRepo({ root: "/repos/Alpha", name: "Alpha" });
    store().setRepoTab("history");
    store().selectCommit("upper-commit");
    store().openIssue({
      repoPath: ALPHA.root,
      repoName: ALPHA.name,
      number: 11,
    });
    render(<WorkDocumentBar />);

    expect(tab("Repositories")).toHaveAttribute("aria-selected", "true");
    expect(tab("Alpha")).toHaveAttribute("aria-selected", "false");
    await user.click(tab("Alpha"));
    await waitFor(() => expect(store().repoPath).toBe("/repos/Alpha"));
    expect(store().repoTab).toBe("history");
    expect(store().selectedCommitHash).toBe("upper-commit");
    expect(store().selectedIssue).toBeNull();
  });

  it("restores each repository tab's selections and navigation history", async () => {
    const user = userEvent.setup();
    store().openRepo(ALPHA);
    store().setRepoTab("history");
    store().selectCommit("alpha-commit");
    store().selectFile({ path: "alpha.ts", staged: false, untracked: false });
    store().selectIssue({ kind: "remote", id: "11" });
    store().openRepo(BRAVO);
    store().setRepoTab("pulls");
    store().selectPr({ kind: "remote", id: "22" });
    render(<WorkDocumentBar />);

    await user.click(tab("alpha"));
    await waitFor(() => expect(store().repoPath).toBe("/repos/alpha"));

    expect(store().repoTab).toBe("history");
    expect(store().selectedCommitHash).toBe("alpha-commit");
    expect(store().selectedFile).toEqual({
      path: "alpha.ts",
      staged: false,
      untracked: false,
    });
    expect(store().selectedIssue).toEqual({ kind: "remote", id: "11" });
    expect(store().navHistory.entries.map((entry) => entry.tab)).toEqual([
      "changes",
      "history",
    ]);

    await user.click(tab("bravo"));
    await waitFor(() => expect(store().repoPath).toBe("/repos/bravo"));

    expect(store().repoTab).toBe("pulls");
    expect(store().selectedPr).toEqual({ kind: "remote", id: "22" });
    expect(store().selectedCommitHash).toBeNull();
    expect(store().navHistory.entries.map((entry) => entry.tab)).toEqual([
      "changes",
      "pulls",
    ]);
  });

  it("keeps a saved current section aligned with history when it becomes hidden", async () => {
    const user = userEvent.setup();
    store().openRepo(ALPHA);
    store().setRepoTab("agent");
    store().openRepo(BRAVO);
    store().setNavHiddenTabs(["agent"]);
    render(<WorkDocumentBar />);

    await user.click(tab("alpha"));
    await waitFor(() => expect(store().repoPath).toBe("/repos/alpha"));

    expect(store().repoTab).toBe("agent");
    expect(store().navHistory.entries[store().navHistory.index].tab).toBe(
      "agent",
    );
    act(() => store().goBack());
    expect(store().repoTab).toBe("changes");
    expect(store().navHistory.entries.map((entry) => entry.tab)).toEqual([
      "changes",
    ]);
  });

  it("shares tab order with MR documents and preserves verified MR activation", async () => {
    const user = userEvent.setup();
    openMr();
    store().openRepo(ALPHA);
    store().setRepoTab("history");
    store().selectCommit("alpha-commit");
    render(<WorkDocumentBar />);

    expect(screen.getAllByRole("tab").map((item) => item.textContent)).toEqual([
      "My works",
      "Repositories",
      "!7Review the merge request",
      "alpha",
    ]);
    await user.click(tab(/Review the merge request/));
    await waitFor(() =>
      expect(tab(/Review the merge request/)).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(store().repoPath).toBe("/repos/mr");
    expect(store().selectedPr).toEqual({ kind: "remote", id: "7" });
    expect(vi.mocked(repoOriginPath).mock.calls).toEqual([["/repos/mr"]]);

    await user.click(tab("alpha"));
    await waitFor(() =>
      expect(tab("alpha")).toHaveAttribute("aria-selected", "true"),
    );
    expect(store().repoTab).toBe("history");
    expect(store().selectedCommitHash).toBe("alpha-commit");
    expect(store().workDocuments.documents).toHaveLength(1);
  });

  it("closes a background repository without moving the focused tab", async () => {
    const user = userEvent.setup();
    store().openRepo(ALPHA);
    store().openRepo(BRAVO);
    store().setRepoTab("history");
    store().selectCommit("bravo-commit");
    render(<WorkDocumentBar />);

    await user.click(
      screen.getByRole("button", { name: "Close repository alpha" }),
    );

    expect(screen.queryByRole("tab", { name: "alpha" })).toBeNull();
    expect(tab("bravo")).toHaveAttribute("aria-selected", "true");
    expect(store().repoPath).toBe("/repos/bravo");
    expect(store().repoTab).toBe("history");
    expect(store().selectedCommitHash).toBe("bravo-commit");
  });

  it("closes active repository tabs through their ordered neighbors, then home", async () => {
    const user = userEvent.setup();
    openMr();
    store().openRepo(ALPHA);
    store().openRepo(BRAVO);
    render(<WorkDocumentBar />);

    await user.click(
      screen.getByRole("button", { name: "Close repository bravo" }),
    );
    await waitFor(() =>
      expect(tab("alpha")).toHaveAttribute("aria-selected", "true"),
    );
    expect(screen.queryByRole("tab", { name: "bravo" })).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Close repository alpha" }),
    );
    await waitFor(() =>
      expect(tab(/Review the merge request/)).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Close team/mr !7" }));
    await waitFor(() =>
      expect(tab("My works")).toHaveAttribute("aria-selected", "true"),
    );
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("keeps a repository tab focused when a background MR tab closes", async () => {
    const user = userEvent.setup();
    openMr();
    store().openRepo(ALPHA);
    render(<WorkDocumentBar />);

    await user.click(screen.getByRole("button", { name: "Close team/mr !7" }));

    expect(store().repoPath).toBe("/repos/alpha");
    expect(tab("alpha")).toHaveAttribute("aria-selected", "true");
    expect(
      screen.queryByRole("tab", { name: /Review the merge request/ }),
    ).toBeNull();
  });

  it("drops a pending repository activation after a newer navigation", async () => {
    const user = userEvent.setup();
    store().openRepo(ALPHA);
    store().openRepo(BRAVO);
    let finish!: (value: RepoInfo) => void;
    vi.mocked(validateRepo).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<WorkDocumentBar />);

    await user.click(tab("alpha"));
    await user.click(tab("My works"));
    await act(async () => finish(ALPHA));

    expect(store().view).toBe("mywork");
    expect(tab("My works")).toHaveAttribute("aria-selected", "true");
    expect(tab("alpha")).toBeVisible();
    expect(tab("bravo")).toBeVisible();
  });

  it("resumes repository-tab activation only after the Settings guard permits it", async () => {
    const user = userEvent.setup();
    store().openRepo(ALPHA);
    store().openRepo(BRAVO);
    store().openSettings();
    let resume: (() => void) | undefined;
    store().setSettingsLeaveGuard((next) => {
      resume = next;
    });
    render(<WorkDocumentBar />);

    await user.click(tab("alpha"));
    expect(store().view).toBe("settings");
    act(() => {
      store().setSettingsLeaveGuard(null);
      resume?.();
    });
    await waitFor(() =>
      expect(tab("alpha")).toHaveAttribute("aria-selected", "true"),
    );
    expect(store().repoPath).toBe("/repos/alpha");
    expect(tab("bravo")).toBeVisible();
  });
});
