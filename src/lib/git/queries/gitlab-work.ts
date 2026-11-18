import {
  type QueryClient,
  queryOptions,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { useMutation } from "@/lib/started-mutation";
import { COLD_START_NO_GH } from "@/lib/test-mode";
import * as api from "../api/gitlab-work";
import type {
  GitLabWorkSection,
  MrListStatus,
  WorkCategory,
  WorkTodoPage,
} from "../types/gitlab-work";

export const GITLAB_WORK_KEY = ["gitlab-work"] as const;
export const GITLAB_WORK_HOSTS_KEY = ["gitlab-work-hosts"] as const;
export const GITLAB_WORK_ACCOUNTS_KEY = ["gitlab-work-accounts"] as const;

const WORK_SECTIONS = [
  "mine",
  "team",
  "mentioned",
  "issues",
] as const satisfies readonly GitLabWorkSection[];
const MR_STATUSES = ["open", "merged"] as const;
// The app-wide preloader and visible list share one account-change baseline.
const accountBaselines = new WeakMap<QueryClient, Map<string, string | null>>();

/** This owner lives outside Activity panels, so navigation never pauses list loading. */
export function useGitLabWorkBackground(
  enabled: boolean,
  labels: readonly string[],
  watchedUrls: readonly string[] = [],
) {
  const hosts = useGitLabWorkHosts(enabled);
  const connected = enabled && (hosts.data?.length ?? 0) > 0;
  useGitLabWorkAccounts(connected);
  useQueries({
    queries: WORK_SECTIONS.flatMap((section) =>
      (section === "issues" ? ["open" as const] : MR_STATUSES).map(
        (status) => ({
          ...gitlabWorkItemsOptions(section, labels, status, watchedUrls),
          enabled: connected && (section !== "team" || labels.length > 0),
        }),
      ),
    ),
  });
  useGitLabWorkTodos(connected);
}

/** Disabled observers read warmed counts without starting a second set of requests. */
export function useGitLabWorkCategoryCounts(
  labels: readonly string[],
  status: MrListStatus = "open",
  watchedUrls: readonly string[] = [],
) {
  const pages = useQueries({
    queries: WORK_SECTIONS.map((section) => ({
      ...gitlabWorkItemsOptions(section, labels, status, watchedUrls),
      enabled: false,
    })),
  });
  const todos = useGitLabWorkTodos(false);
  return Object.fromEntries([
    ...WORK_SECTIONS.map((section, index) => [
      section,
      section === "team" && labels.length === 0
        ? null
        : (pages[index].data?.items.length ?? null),
    ]),
    ["todos", todos.data?.items.length ?? null],
  ]) as Record<WorkCategory, number | null>;
}

export function useGitLabWorkAccounts(enabled: boolean) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: GITLAB_WORK_ACCOUNTS_KEY,
    queryFn: api.gitlabWorkAccounts,
    enabled,
    staleTime: 0,
    retry: false,
  });
  useEffect(() => {
    if (!query.data) return;
    const previous = accountBaselines.get(client);
    const next = new Map(
      query.data.map((account) => [
        account.host,
        account.login ?? previous?.get(account.host) ?? null,
      ]),
    );
    const changed =
      previous !== undefined &&
      (previous.size !== next.size ||
        [...next].some(([host, login]) => previous.get(host) !== login));
    accountBaselines.set(client, next);
    if (changed) void client.resetQueries({ queryKey: GITLAB_WORK_KEY });
  }, [query.data, client]);
  return query;
}

export function useGitLabWorkHosts(enabled: boolean) {
  return useQuery({
    queryKey: GITLAB_WORK_HOSTS_KEY,
    queryFn: COLD_START_NO_GH
      ? () => Promise.resolve([] as string[])
      : api.gitlabWorkHosts,
    enabled,
    staleTime: 5 * 60_000,
    networkMode: "always",
    retry: false,
  });
}

export function gitlabWorkItemsOptions(
  section: GitLabWorkSection,
  labels: readonly string[],
  status: MrListStatus = "open",
  watchedUrls: readonly string[] = [],
) {
  const teamLabels = section === "team" ? [...labels].sort() : [];
  const state = section === "issues" ? "open" : status;
  const watches = section === "mine" ? [...new Set(watchedUrls)].sort() : [];
  return queryOptions({
    queryKey: [...GITLAB_WORK_KEY, section, teamLabels, state, watches],
    queryFn: () => api.gitlabWorkItems(section, teamLabels, state, watches),
    placeholderData: (previous, query) =>
      section === "mine" &&
      query?.queryKey[1] === "mine" &&
      query.queryKey[3] === state
        ? previous
        : undefined,
    staleTime: 60_000,
    refetchInterval: section === "mine" && watches.length > 0 ? 60_000 : false,
    retry: false,
  });
}

export function useGitLabWorkItems(
  section: GitLabWorkSection,
  labels: string[],
  enabled: boolean,
  status: MrListStatus = "open",
  watchedUrls: readonly string[] = [],
) {
  return useQuery({
    ...gitlabWorkItemsOptions(section, labels, status, watchedUrls),
    enabled: enabled && (section !== "team" || labels.length > 0),
  });
}

export function useWatchGitLabMergeRequest() {
  return useMutation({
    mutationFn: (url: string) => api.gitlabWatchMergeRequest(url),
  });
}

export function gitlabWorkTodosOptions() {
  return queryOptions({
    queryKey: [...GITLAB_WORK_KEY, "todos"],
    queryFn: api.gitlabWorkTodos,
    staleTime: 60_000,
    retry: false,
  });
}

export function useGitLabWorkTodos(enabled: boolean) {
  return useQuery({ ...gitlabWorkTodosOptions(), enabled });
}

export function useCompleteWorkTodo() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ host, id }: { host: string; id: string }) =>
      api.gitlabWorkTodoDone(host, id),
    onSuccess: (_, target) =>
      client.setQueryData<WorkTodoPage>(
        [...GITLAB_WORK_KEY, "todos"],
        (page) =>
          page
            ? {
                ...page,
                items: page.items.filter(
                  (todo) => todo.host !== target.host || todo.id !== target.id,
                ),
              }
            : page,
      ),
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: [...GITLAB_WORK_KEY, "todos"] }),
        client.invalidateQueries({
          queryKey: [...GITLAB_WORK_KEY, "mentioned"],
        }),
      ]);
    },
  });
}
