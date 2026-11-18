import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WatchMrDialog } from "@/features/mywork/WatchMrDialog";
import type { MyWorkItem } from "@/lib/git/types";
import {
  type AppSettings,
  loadSettings,
  saveSettingsPatch,
} from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useSettings } from "@/lib/settings/queries";

type WatchResolution = {
  item: MyWorkItem;
  state: "opened" | "merged" | "closed";
};
type WatchSettings = AppSettings & { myWorkWatchedMergeRequests: string[] };

const native = vi.hoisted(() => ({
  resolve: vi.fn<(url: string) => Promise<WatchResolution>>(),
}));
vi.mock("@/lib/git/api/gitlab-work", async (original) => ({
  ...(await original<typeof import("@/lib/git/api/gitlab-work")>()),
  gitlabWatchMergeRequest: native.resolve,
}));
vi.mock("@/lib/settings/api", async (original) => ({
  ...(await original<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
  saveSettingsPatch: vi.fn(),
}));

const CANONICAL =
  "https://git.example.test/team/subgroup/repo/-/merge_requests/7";
const PASTED = `${CANONICAL}?diff_id=24#note_99`;
const OTHER = "https://git.other.test/other/repo/-/merge_requests/9";
const ITEM: MyWorkItem = {
  number: 7,
  title: "Retain this merge request",
  isPullRequest: true,
  isDraft: false,
  repoFullName: "team/subgroup/repo",
  repoOwner: "team/subgroup",
  repoName: "repo",
  host: "git.example.test",
  url: CANONICAL,
  updatedAt: "2026-11-17T01:00:00Z",
  authorLogin: "another-user",
  labels: [],
  labelColors: {},
  provider: "gitlab",
};

let stored: WatchSettings;

beforeEach(() => {
  stored = {
    ...structuredClone(DEFAULT_SETTINGS),
    myWorkWatchedMergeRequests: [],
  };
  native.resolve.mockReset();
  native.resolve.mockResolvedValue({ item: ITEM, state: "opened" });
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(stored),
  );
  vi.mocked(saveSettingsPatch).mockReset();
  vi.mocked(saveSettingsPatch).mockImplementation(async (patch) => {
    stored = { ...stored, ...structuredClone(patch) };
    return structuredClone(stored);
  });
});

function Host() {
  const [open, setOpen] = useState(false);
  const settings = useSettings();
  const watched =
    (settings.data as WatchSettings | undefined)?.myWorkWatchedMergeRequests ??
    [];
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Watch MR…
      </button>
      <WatchMrDialog open={open} onOpenChange={setOpen} />
      <output aria-label="Watched merge requests">{watched.join("\n")}</output>
    </>
  );
}

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Host />
    </QueryClientProvider>,
  );
}

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Watch MR…" }));
  return screen.findByRole("dialog", { name: "Watch MR" });
}

async function pasteAndWatch(
  user: ReturnType<typeof userEvent.setup>,
  url = PASTED,
) {
  const input = await screen.findByRole("textbox", {
    name: "Merge request URL",
  });
  await user.click(input);
  await user.paste(url);
  await user.click(screen.getByRole("button", { name: "Watch MR" }));
  return input;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Watch MR dialog", () => {
  it("persists the resolved canonical URL and keeps it after remounting", async () => {
    stored.myWorkWatchedMergeRequests = [OTHER];
    const user = userEvent.setup();
    const first = show();
    await open(user);
    await pasteAndWatch(user, `  ${PASTED}  `);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(native.resolve).toHaveBeenCalledWith(PASTED);
    expect(saveSettingsPatch).toHaveBeenCalledWith({
      myWorkWatchedMergeRequests: [OTHER, CANONICAL],
    });
    expect(stored.myWorkWatchedMergeRequests).toEqual([OTHER, CANONICAL]);
    first.unmount();

    show();
    await waitFor(() =>
      expect(screen.getByLabelText("Watched merge requests")).toHaveTextContent(
        CANONICAL,
      ),
    );
    await open(user);
    expect(
      screen.getByRole("textbox", { name: "Merge request URL" }),
    ).toHaveValue("");
  });

  it("watching the same canonical MR again succeeds without a duplicate write", async () => {
    stored.myWorkWatchedMergeRequests = [CANONICAL];
    const user = userEvent.setup();
    show();
    await open(user);
    await pasteAndWatch(user);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(stored.myWorkWatchedMergeRequests).toEqual([CANONICAL]);
    expect(saveSettingsPatch).not.toHaveBeenCalled();
  });

  it("rejects a closed MR inline without losing the pasted link", async () => {
    native.resolve.mockResolvedValueOnce({ item: ITEM, state: "closed" });
    const user = userEvent.setup();
    show();
    await open(user);
    const input = await pasteAndWatch(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(/closed/i);
    expect(screen.getByRole("dialog", { name: "Watch MR" })).toBeVisible();
    expect(input).toHaveValue(PASTED);
    expect(saveSettingsPatch).not.toHaveBeenCalled();
  });

  it("accepts a merged MR so it can remain in the Merged list", async () => {
    native.resolve.mockResolvedValueOnce({ item: ITEM, state: "merged" });
    const user = userEvent.setup();
    show();
    await open(user);
    await pasteAndWatch(user);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(stored.myWorkWatchedMergeRequests).toEqual([CANONICAL]);
  });

  it("keeps remote failures inline and lets the same link be retried", async () => {
    native.resolve.mockRejectedValueOnce({
      kind: "glab",
      message: "Cannot reach GitLab. Try again.",
    });
    const user = userEvent.setup();
    show();
    await open(user);
    const input = await pasteAndWatch(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Cannot reach GitLab. Try again.",
    );
    expect(input).toHaveValue(PASTED);
    expect(saveSettingsPatch).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Watch MR" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(stored.myWorkWatchedMergeRequests).toEqual([CANONICAL]);
  });

  it("keeps a failed settings save open and persists on retry", async () => {
    vi.mocked(saveSettingsPatch).mockRejectedValueOnce(new Error("disk full"));
    const user = userEvent.setup();
    show();
    await open(user);
    const input = await pasteAndWatch(user);

    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    expect(input).toHaveValue(PASTED);
    expect(stored.myWorkWatchedMergeRequests).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Watch MR" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(stored.myWorkWatchedMergeRequests).toEqual([CANONICAL]);
  });

  it("holds submission while resolution and persistence are pending", async () => {
    const resolution = deferred<WatchResolution>();
    const save = deferred<AppSettings>();
    native.resolve.mockReturnValueOnce(resolution.promise);
    vi.mocked(saveSettingsPatch).mockReturnValueOnce(save.promise);
    const user = userEvent.setup();
    show();
    await open(user);
    await pasteAndWatch(user);
    const submit = screen.getByRole("button", { name: /Watch/ });
    expect(submit).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Enter}{Enter}");
    expect(native.resolve).toHaveBeenCalledTimes(1);

    await act(async () => resolution.resolve({ item: ITEM, state: "opened" }));
    await waitFor(() => expect(saveSettingsPatch).toHaveBeenCalledTimes(1));
    expect(submit).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("dialog", { name: "Watch MR" })).toBeVisible();
    await act(async () => {
      stored = { ...stored, myWorkWatchedMergeRequests: [CANONICAL] };
      save.resolve(stored);
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("refuses a 101st watch with an actionable limit message", async () => {
    stored.myWorkWatchedMergeRequests = Array.from(
      { length: 100 },
      (_, index) => `${OTHER.slice(0, -1)}${index + 100}`,
    );
    const user = userEvent.setup();
    show();
    await open(user);
    await pasteAndWatch(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(/100/);
    expect(screen.getByRole("alert")).toHaveTextContent(/stop watching/i);
    expect(stored.myWorkWatchedMergeRequests).toHaveLength(100);
    expect(saveSettingsPatch).not.toHaveBeenCalled();
  });

  it("allows an existing watch when the list is at its limit", async () => {
    stored.myWorkWatchedMergeRequests = [
      CANONICAL,
      ...Array.from(
        { length: 99 },
        (_, index) => `${OTHER.slice(0, -1)}${index + 100}`,
      ),
    ];
    const user = userEvent.setup();
    show();
    await open(user);
    await pasteAndWatch(user);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(stored.myWorkWatchedMergeRequests).toHaveLength(100);
    expect(saveSettingsPatch).not.toHaveBeenCalled();
  });

  it("stops watching a saved URL without resolving it and frees room for another MR", async () => {
    stored.myWorkWatchedMergeRequests = Array.from(
      { length: 100 },
      (_, index) => `${OTHER.slice(0, -1)}${index + 100}`,
    );
    const removed = stored.myWorkWatchedMergeRequests[0];
    const remaining = stored.myWorkWatchedMergeRequests.slice(1);
    const user = userEvent.setup();
    show();
    await open(user);

    const summary = screen.getByText("Watched merge requests (100)");
    expect(summary.closest("details")).not.toHaveAttribute("open");
    await user.click(summary);
    await user.click(
      screen.getByRole("button", { name: `Stop watching ${removed}` }),
    );

    await screen.findByText("Watched merge requests (99)");
    expect(stored.myWorkWatchedMergeRequests).toEqual(remaining);
    expect(saveSettingsPatch).toHaveBeenCalledWith({
      myWorkWatchedMergeRequests: remaining,
    });
    expect(native.resolve).not.toHaveBeenCalled();
    await pasteAndWatch(user);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(stored.myWorkWatchedMergeRequests).toHaveLength(100);
    expect(stored.myWorkWatchedMergeRequests).toContain(CANONICAL);
    expect(stored.myWorkWatchedMergeRequests).not.toContain(removed);
  });
});
