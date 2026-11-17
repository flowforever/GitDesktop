import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useWorkTabNavigation,
  WorkDocumentBar,
} from "@/features/mywork/WorkDocumentBar";
import { repoOriginPath, validateRepo } from "@/lib/git/api/repo";
import { hasLiveHandler } from "@/lib/hotkeys/handler-registry";
import { dispatchAction } from "@/lib/hotkeys/hotkeys";
import { useUiStore } from "@/lib/stores/ui";

vi.mock("@/lib/git/api/repo", async (original) => ({
  ...(await original<typeof import("@/lib/git/api/repo")>()),
  validateRepo: vi.fn(),
  repoOriginPath: vi.fn(),
}));

const store = () => useUiStore.getState();
const FIRST = {
  host: "git.test",
  repoFullName: "team/repo",
  number: 7,
  title: "First merge request",
  repoPath: "/repos/repo",
  repoName: "repo",
};
const SECOND = { ...FIRST, number: 8, title: "Second merge request" };

function openDocuments() {
  for (const document of [FIRST, SECOND]) {
    store().openPr({
      kind: "remote",
      ref: String(document.number),
      repoPath: document.repoPath,
      repoName: document.repoName,
      section: "conversation",
      document,
    });
  }
}

beforeEach(() => {
  useUiStore.setState(useUiStore.getInitialState(), true);
  vi.mocked(validateRepo).mockResolvedValue({
    root: FIRST.repoPath,
    name: FIRST.repoName,
  });
  vi.mocked(repoOriginPath).mockResolvedValue({
    provider: "gitlab",
    host: FIRST.host,
    authority: FIRST.host,
    path: FIRST.repoFullName,
  });
});

const tab = (name: string | RegExp) => screen.getByRole("tab", { name });

function WorkTabsHost({
  visible = true,
  enabled = true,
}: {
  visible?: boolean;
  enabled?: boolean;
}) {
  useWorkTabNavigation(enabled);
  return visible ? <WorkDocumentBar /> : null;
}

describe("fixed work tabs", () => {
  it("keeps My works and Repositories available without any MR documents", async () => {
    const user = userEvent.setup();
    render(<WorkDocumentBar />);

    expect(screen.getAllByRole("tab").map((item) => item.textContent)).toEqual([
      "My works",
      "Repositories",
    ]);
    expect(tab("My works")).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("button", { name: /^Close / })).toBeNull();

    await user.click(tab("Repositories"));

    expect(store().view).toBe("welcome");
    expect(tab("Repositories")).toHaveAttribute("aria-selected", "true");
    expect(tab("Repositories")).toHaveAttribute("tabindex", "0");
    expect(tab("My works")).toHaveAttribute("tabindex", "-1");

    await user.click(tab("My works"));

    expect(store().view).toBe("mywork");
    expect(tab("My works")).toHaveAttribute("aria-selected", "true");
  });

  it("leaves MR tabs open when switching between the chooser and My works", async () => {
    const user = userEvent.setup();
    store().setWorkCategory("team");
    openDocuments();
    render(<WorkDocumentBar />);
    expect(tab(/Second merge request/)).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.click(tab("Repositories"));

    expect(store().view).toBe("welcome");
    expect(store().workDocuments.activeId).toBeNull();
    expect(
      store().workDocuments.documents.map((document) => document.number),
    ).toEqual([7, 8]);
    expect(tab("Repositories")).toHaveAttribute("aria-selected", "true");
    expect(tab(/First merge request/)).toBeVisible();
    expect(tab(/Second merge request/)).toBeVisible();

    await user.click(tab(/First merge request/));
    await waitFor(() =>
      expect(tab(/First merge request/)).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(store().repoPath).toBe("/repos/repo");
    expect(store().selectedPr).toEqual({ kind: "remote", id: "7" });

    await user.click(tab("My works"));

    expect(store().workCategory).toBe("team");
    expect(store().workDocuments.documents).toHaveLength(2);
    expect(tab("My works")).toHaveAttribute("aria-selected", "true");
  });

  it.each([
    { repoTab: "changes" as const },
    { selectedPr: { kind: "remote" as const, id: "99" } },
    { selectedPr: { kind: "local" as const, id: "8" } },
    { repoPath: "/repos/another" },
  ])(
    "selects Repositories when the visible repository is not the active document: %j",
    (patch) => {
      openDocuments();
      useUiStore.setState(patch);
      render(<WorkDocumentBar />);

      expect(tab("Repositories")).toHaveAttribute("aria-selected", "true");
      expect(tab(/Second merge request/)).toHaveAttribute(
        "aria-selected",
        "false",
      );
      expect(screen.getAllByRole("tab", { selected: true })).toHaveLength(1);
    },
  );

  it("moves between the fixed tabs with arrows, Home and End", async () => {
    const user = userEvent.setup();
    render(<WorkDocumentBar />);
    tab("My works").focus();

    await user.keyboard("{ArrowRight}");
    expect(tab("Repositories")).toHaveFocus();
    expect(tab("Repositories")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}");
    expect(tab("My works")).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(tab("Repositories")).toHaveFocus();
    await user.keyboard("{Home}{End}");
    expect(tab("Repositories")).toHaveFocus();

    const chord = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    tab("Repositories").dispatchEvent(chord);
    expect(chord.defaultPrevented).toBe(false);
    expect(store().view).toBe("welcome");
  });

  it("cycles the fixed tabs and MR documents in their displayed order", async () => {
    const user = userEvent.setup();
    openDocuments();
    store().openMyWork();
    render(<WorkDocumentBar />);
    tab("My works").focus();

    await user.keyboard("{ArrowRight}{ArrowRight}");
    await waitFor(() =>
      expect(tab(/First merge request/)).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(tab(/First merge request/)).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    await waitFor(() =>
      expect(tab(/Second merge request/)).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    await user.keyboard("{ArrowRight}");
    expect(tab("My works")).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{End}");
    await waitFor(() =>
      expect(tab(/Second merge request/)).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    await user.keyboard("{Home}");
    expect(tab("My works")).toHaveAttribute("aria-selected", "true");
  });

  it("includes both fixed tabs in the next and previous work-tab commands", () => {
    render(<WorkTabsHost />);

    act(() => {
      expect(dispatchAction("work-next-document")).toBe(true);
    });
    expect(store().view).toBe("welcome");
    expect(tab("Repositories")).toHaveAttribute("aria-selected", "true");

    act(() => {
      expect(dispatchAction("work-previous-document")).toBe(true);
    });
    expect(store().view).toBe("mywork");
  });

  it("keeps disabled work-tab commands registered while the tab bar is concealed", () => {
    const host = render(<WorkTabsHost />);

    host.rerender(<WorkTabsHost visible={false} enabled={false} />);

    expect(screen.queryByRole("tablist")).toBeNull();
    expect(hasLiveHandler("work-next-document")).toBe(true);
    expect(hasLiveHandler("work-previous-document")).toBe(true);
    act(() => {
      expect(dispatchAction("work-next-document")).toBe(false);
      expect(dispatchAction("work-previous-document")).toBe(false);
    });
    expect(store().view).toBe("mywork");
  });

  it("keeps repository navigation behind the Settings leave guard", async () => {
    const user = userEvent.setup();
    openDocuments();
    store().openSettings();
    let resume: (() => void) | undefined;
    store().setSettingsLeaveGuard((next) => {
      resume = next;
    });
    render(<WorkDocumentBar />);

    await user.click(tab("Repositories"));

    expect(store().view).toBe("settings");
    expect(store().workDocuments.documents).toHaveLength(2);
    act(() => {
      store().setSettingsLeaveGuard(null);
      resume?.();
    });
    expect(store().view).toBe("welcome");
    expect(store().workDocuments.activeId).toBeNull();
    expect(tab("Repositories")).toHaveAttribute("aria-selected", "true");
  });

  it("does not let navigation keys on a close button activate a fixed tab", () => {
    openDocuments();
    render(<WorkDocumentBar />);
    const close = screen.getByRole("button", { name: "Close team/repo !8" });

    fireEvent.keyDown(close, { key: "Home" });

    expect(tab(/Second merge request/)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(store().workDocuments.documents).toHaveLength(2);
  });

  it.each([
    {
      patch: { repoTab: "changes" as const },
      tab: "changes",
      selected: { kind: "remote", id: "8" },
    },
    {
      patch: { selectedPr: { kind: "remote" as const, id: "7" } },
      tab: "pulls",
      selected: { kind: "remote", id: "7" },
    },
  ])(
    "closes a background MR without leaving the repository view: $tab",
    async ({ patch, tab: expectedTab, selected }) => {
      const user = userEvent.setup();
      openDocuments();
      useUiStore.setState(patch);
      render(<WorkDocumentBar />);

      await user.click(
        screen.getByRole("button", { name: "Close team/repo !8" }),
      );
      await waitFor(() =>
        expect(store().workDocuments.documents).toHaveLength(1),
      );

      expect(store().view).toBe("repo");
      expect(store().repoTab).toBe(expectedTab);
      expect(store().selectedPr).toEqual(selected);
      expect(store().workDocuments.activeId).toBeNull();
      expect(tab("Repositories")).toHaveAttribute("aria-selected", "true");
    },
  );
});
