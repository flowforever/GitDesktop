import type { MyWorkItem } from "./forge-repos";

export type GitLabWorkSection =
  | "mine"
  | "authored"
  | "team"
  | "mentioned"
  | "issues";
export type WorkCategory = GitLabWorkSection | "todos";

export interface WorkTodo {
  id: string;
  host: string;
  title: string;
  action: string;
  targetType: string;
  url: string;
  updatedAt: string;
  item: MyWorkItem | null;
}

export interface WorkTodoPage {
  items: WorkTodo[];
  truncated: boolean;
}
