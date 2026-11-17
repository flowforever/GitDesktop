import { invoke } from "@/lib/tauri/invoke";
import type { MyWorkPage } from "../types/forge-repos";
import type { GitLabWorkSection, WorkTodoPage } from "../types/gitlab-work";

export const gitlabWorkHosts = () => invoke<string[]>("gitlab_work_hosts");
export const gitlabWorkAccounts = () =>
  invoke<{ host: string; login: string | null }[]>("gitlab_work_accounts");
export const gitlabWorkItems = (section: GitLabWorkSection, labels: string[]) =>
  invoke<MyWorkPage>("gitlab_work_items", { section, labels });
export const gitlabWorkTodos = () => invoke<WorkTodoPage>("gitlab_work_todos");
export const gitlabWorkTodoDone = (host: string, id: string) =>
  invoke<void>("gitlab_work_todo_done", { host, id });
