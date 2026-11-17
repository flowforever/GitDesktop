import type { WorkCategory } from "@/lib/git/types/gitlab-work";

export const WORK_CATEGORIES = [
  { value: "mine", label: "My Merge Requests" },
  { value: "authored", label: "Authored by Me" },
  { value: "team", label: "Team Merge Requests" },
  { value: "mentioned", label: "Mentioned Me" },
  { value: "todos", label: "Todos" },
  { value: "issues", label: "Issues" },
] as const satisfies readonly { value: WorkCategory; label: string }[];
