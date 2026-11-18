import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MyWorkScreen } from "@/features/mywork/MyWorkScreen";
import { WorkItemMetadata } from "@/features/mywork/WorkItemMetadata";
import { TabPanel } from "@/features/repository/TabPanel";
import {
  GITLAB_WORK_KEY,
  gitlabWorkItemsOptions,
  useGitLabWorkBackground,
} from "@/lib/git/queries/gitlab-work";
import type { MyWorkItem } from "@/lib/git/types";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";
import { getTransport, installTransport } from "@/lib/transport";

let labels: string[];
let hosts: string[];
let sections: string[];
let requests: { section: string; status: string; watchedUrls: string[] }[];
let watches: string[];
let todoReads: number;
let failSection: string | null;
let blockedSection: string | null;
let release: (() => void) | undefined;
let previousTransport: ReturnType<typeof getTransport>;
const clients: QueryClient[] = [];

vi.mock("@/lib/settings/queries", async (original) => ({
  ...(await original<typeof import("@/lib/settings/queries")>()),
  useSettings: () => ({
    data: {
      ...DEFAULT_SETTINGS,
      recentRepos: [],
      myWorkTeamLabels: labels,
      myWorkWatchedMergeRequests: watches,
    },
    isPending: false,
  }),
}));

const item = (section: string): MyWorkItem => ({
  provider: "gitlab",
  host: "git.test",
  number: section === "issues" ? 8 : 7,
  title: `${section} work item`,
  repoFullName: "team/repo",
  repoOwner: "team",
  repoName: "repo",
  isPullRequest: section !== "issues",
  isDraft: false,
  authorLogin: "alice",
  labels: ["Team Blue", "needs review"],
  labelColors: { "Team Blue": "#428bca", "needs review": "not-a-color" },
  updatedAt: "2026-11-18T01:00:00Z",
  url: `https://git.test/team/repo/-/${section === "issues" ? "issues" : "merge_requests"}/${section === "issues" ? 8 : 7}`,
});

beforeEach(() => {
  labels = [];
  hosts = ["git.test"];
  sections = [];
  requests = [];
  watches = [];
  todoReads = 0;
  failSection = null;
  blockedSection = null;
  release = undefined;
  previousTransport = getTransport();
  useUiStore.setState(useUiStore.getInitialState(), true);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 600,
    right: 1000,
    width: 1000,
    height: 600,
    toJSON: () => ({}),
  });
  installTransport({
    invoke: async <T,>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      if (command === "gitlab_work_hosts") return hosts as T;
      if (command === "gitlab_work_accounts")
        return [{ host: "git.test", login: "viewer" }] as T;
      if (command === "gitlab_work_items") {
        const section = String(args?.section);
        sections.push(section);
        const status = String(args?.status);
        requests.push({
          section,
          status,
          watchedUrls: (args?.watchedUrls as string[]) ?? [],
        });
        if (section === failSection)
          throw new Error("This category is unavailable");
        if (section === blockedSection && status !== "merged")
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return {
          items: [
            {
              ...item(section),
              title: `${status === "merged" ? "merged " : ""}${section} work item`,
            },
          ],
          truncated: false,
        } as T;
      }
      if (command === "gitlab_work_todos") {
        todoReads++;
        return {
          items: [
            {
              id: "1",
              host: "git.test",
              title: "Background todo",
              action: "mentioned",
              targetType: "MergeRequest",
              url: item("mine").url,
              updatedAt: item("mine").updatedAt,
              item: item("mine"),
            },
          ],
          truncated: false,
        } as T;
      }
      throw new Error(`Unexpected command: ${command}`);
    },
  });
});
afterEach(() => {
  release?.();
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  installTransport(previousTransport);
  vi.restoreAllMocks();
});

function Background({
  enabled,
  teamLabels,
}: {
  enabled: boolean;
  teamLabels: string[];
}) {
  useGitLabWorkBackground(enabled, teamLabels, watches);
  return null;
}
function show({ visible = true, enabled = true, background = true } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  const content = (shown: boolean) => (
    <QueryClientProvider client={client}>
      {background && <Background enabled={enabled} teamLabels={labels} />}
      <TabPanel active={shown}>
        <MyWorkScreen active={shown} />
      </TabPanel>
    </QueryClientProvider>
  );
  const view = render(content(visible));
  return {
    ...view,
    client,
    reveal: () => view.rerender(content(true)),
    update: () => view.rerender(content(visible)),
  };
}

describe("My works background lists", () => {
  it("keeps labels named like object properties readable without reported colors", () => {
    render(
      <WorkItemMetadata
        item={{
          labels: ["constructor", "__proto__", "toString"],
          labelColors: {},
        }}
      />,
    );
    for (const label of ["constructor", "__proto__", "toString"])
      expect(screen.getByText(label)).toBeVisible();
  });
  it("keeps text readable on whole-label backgrounds", () => {
    render(
      <WorkItemMetadata
        item={{
          labels: ["Dark", "Light", "Invalid"],
          labelColors: {
            Dark: "123456",
            Light: "FFFF00",
            Invalid: "not-a-color",
          },
        }}
      />,
    );
    expect(screen.getByText("Dark").closest("[data-slot=badge]")).toHaveStyle({
      backgroundColor: "#123456",
      color: "#ffffff",
    });
    expect(screen.getByText("Light").closest("[data-slot=badge]")).toHaveStyle({
      backgroundColor: "#ffff00",
      color: "#000000",
    });
    expect(
      screen.getByText("Invalid").closest("[data-slot=badge]"),
    ).not.toHaveAttribute("style");
  });
  it("loads MR, issue and Todo pages while the home panel is hidden", async () => {
    const { client } = show({ visible: false });
    await waitFor(() =>
      expect(new Set(sections)).toEqual(
        new Set(["mine", "mentioned", "issues"]),
      ),
    );
    await waitFor(() => expect(todoReads).toBe(1));
    expect(
      client.getQueryData(
        gitlabWorkItemsOptions("mentioned", [], "open", watches).queryKey,
      ),
    ).toMatchObject({
      items: [{ authorLogin: "alice", labels: ["Team Blue", "needs review"] }],
    });
    expect(sections).not.toContain("team");
    expect(new Set(requests.map((r) => `${r.section}:${r.status}`))).toEqual(
      new Set([
        "mine:open",
        "mine:merged",
        "mentioned:open",
        "mentioned:merged",
        "issues:open",
      ]),
    );
  });
  it("uses one personal tab and filters each MR category by status before the search box", async () => {
    labels = ["Team Blue"];
    show();
    await screen.findByText("mine work item");
    expect(
      screen.queryByRole("tab", { name: /Authored by Me/ }),
    ).not.toBeInTheDocument();
    const status = screen.getByRole("group", { name: "MR status" });
    const filter = screen.getByRole("combobox", { name: "Filter your work" });
    expect(
      status.compareDocumentPosition(filter) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(within(status).getByRole("button", { name: "Merged" }));
    expect(await screen.findByText("merged mine work item")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: /^Team Merge Requests/ }));
    expect(await screen.findByText("merged team work item")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: /^Mentioned Me/ }));
    expect(await screen.findByText("merged mentioned work item")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: /^Issues/ }));
    expect(await screen.findByText("issues work item")).toBeVisible();
    expect(
      screen.queryByRole("group", { name: "MR status" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /^Todos/ }));
    expect(
      screen.queryByRole("group", { name: "MR status" }),
    ).not.toBeInTheDocument();
  });
  it("refreshes personal lists when a watch is added without changing other category identities", async () => {
    const view = show({ visible: false });
    await waitFor(() => expect(todoReads).toBe(1));
    const teamReads = requests.filter((r) => r.section === "mentioned").length;
    watches = ["https://git.test/team/repo/-/merge_requests/99"];
    view.update();
    await waitFor(() =>
      expect(requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            section: "mine",
            status: "open",
            watchedUrls: watches,
          }),
          expect.objectContaining({
            section: "mine",
            status: "merged",
            watchedUrls: watches,
          }),
        ]),
      ),
    );
    expect(requests.filter((r) => r.section === "mentioned")).toHaveLength(
      teamReads,
    );
  });
  it("keeps the visible personal rows while an added watch refreshes the list", async () => {
    const view = show();
    await screen.findByText("mine work item");
    blockedSection = "mine";
    watches = ["https://git.test/team/repo/-/merge_requests/99"];
    view.update();
    await waitFor(() =>
      expect(requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            section: "mine",
            status: "open",
            watchedUrls: watches,
          }),
        ]),
      ),
    );
    expect(screen.getByText("mine work item")).toBeVisible();
    await act(async () => release?.());
  });
  it("opens a prefetched category immediately and keeps its rows during a refresh", async () => {
    const view = show({ visible: false });
    await waitFor(() =>
      expect(
        view.client.getQueryData(
          gitlabWorkItemsOptions("mentioned", [], "open", watches).queryKey,
        ),
      ).toBeDefined(),
    );
    view.reveal();
    fireEvent.click(screen.getByRole("tab", { name: /^Mentioned Me/ }));
    expect(screen.getByText("mentioned work item")).toBeVisible();
    const before = requests.filter(
      (r) => r.section === "mentioned" && r.status === "open",
    ).length;
    blockedSection = "mentioned";
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(
        requests.filter(
          (r) => r.section === "mentioned" && r.status === "open",
        ),
      ).toHaveLength(before + 1),
    );
    expect(screen.getByText("mentioned work item")).toBeVisible();
    await act(async () => {
      release?.();
    });
  });
  it("only loads team MRs after labels are configured", async () => {
    const view = show({ visible: false });
    await waitFor(() => expect(todoReads).toBe(1));
    expect(sections).not.toContain("team");
    labels = ["Team Blue"];
    view.update();
    await waitFor(() =>
      expect(
        view.client.getQueryData(
          gitlabWorkItemsOptions("team", ["Team Blue"], "open", watches)
            .queryKey,
        ),
      ).toBeDefined(),
    );
  });
  it("does not let a failed background category blank the selected list", async () => {
    failSection = "mentioned";
    show();
    await screen.findByText("mine work item");
    await waitFor(() => expect(sections).toContain("mentioned"));
    expect(screen.getByText("mine work item")).toBeVisible();
    expect(
      screen.queryByText("This category is unavailable"),
    ).not.toBeInTheDocument();
  });
  it("does not request work pages when no GitLab host is connected", async () => {
    hosts = [];
    const view = show({ visible: false });
    await waitFor(() =>
      expect(view.client.getQueryData(["gitlab-work-hosts"])).toEqual([]),
    );
    expect(sections).toEqual([]);
    expect(todoReads).toBe(0);
  });
  it("shows the author and labels on each loaded MR row", async () => {
    show({ background: false });
    const row = await screen.findByRole("option", { name: /mine work item/ });
    expect(within(row).getByText("@alice")).toBeVisible();
    expect(within(row).getByText("Team Blue")).toBeVisible();
    expect(within(row).getByText("needs review")).toBeVisible();
    expect(
      within(row).getByText("mine work item").parentElement,
    ).toContainElement(within(row).getByText("Team Blue"));
    expect(
      within(row).getByText("Team Blue").closest("[data-slot=badge]"),
    ).toHaveStyle({
      backgroundColor: "#428bca",
      color: "#000000",
    });
    expect(
      within(row)
        .getByText("needs review")
        .parentElement?.querySelector("[style]"),
    ).toBeNull();
  });
  it("shows MR metadata on a prefetched Todo target", async () => {
    const view = show();
    await waitFor(() =>
      expect(
        view.client.getQueryData([...GITLAB_WORK_KEY, "todos"]),
      ).toBeDefined(),
    );
    fireEvent.click(screen.getByRole("tab", { name: /^Todos/ }));
    const row = await screen.findByRole("button", { name: /^Background todo/ });
    expect(within(row).getByText("@alice")).toBeVisible();
    expect(within(row).getByText("Team Blue")).toBeVisible();
  });
});
