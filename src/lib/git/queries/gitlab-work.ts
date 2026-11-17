import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useMutation } from "@/lib/started-mutation";
import { COLD_START_NO_GH } from "@/lib/test-mode";
import * as api from "../api/gitlab-work";
import type { GitLabWorkSection, WorkTodoPage } from "../types/gitlab-work";

export const GITLAB_WORK_KEY = ["gitlab-work"] as const;
export const GITLAB_WORK_HOSTS_KEY = ["gitlab-work-hosts"] as const;
export const GITLAB_WORK_ACCOUNTS_KEY = ["gitlab-work-accounts"] as const;

export function useGitLabWorkAccounts(enabled: boolean) {
  const client = useQueryClient();
  const previous = useRef<Map<string, string | null> | null>(null);
  const query = useQuery({
    queryKey: GITLAB_WORK_ACCOUNTS_KEY,
    queryFn: api.gitlabWorkAccounts,
    enabled,
    staleTime: 0,
    retry: false,
  });
  useEffect(() => {
    if (!query.data) return;
    const next = new Map(
      query.data.map((account) => [
        account.host,
        account.login ?? previous.current?.get(account.host) ?? null,
      ]),
    );
    const changed =
      previous.current !== null &&
      (previous.current.size !== next.size ||
        [...next].some(
          ([host, login]) => previous.current?.get(host) !== login,
        ));
    previous.current = next;
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

export function useGitLabWorkItems(
  section: GitLabWorkSection,
  labels: string[],
  enabled: boolean,
) {
  const teamLabels = section === "team" ? [...labels].sort() : [];
  return useQuery({
    queryKey: [...GITLAB_WORK_KEY, section, teamLabels],
    queryFn: () => api.gitlabWorkItems(section, teamLabels),
    enabled: enabled && (section !== "team" || teamLabels.length > 0),
    staleTime: 60_000,
    retry: false,
  });
}

export function useGitLabWorkTodos(enabled: boolean) {
  return useQuery({
    queryKey: [...GITLAB_WORK_KEY, "todos"],
    queryFn: api.gitlabWorkTodos,
    enabled,
    staleTime: 60_000,
    retry: false,
  });
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
