import { CheckIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { ListRowSkeletons } from "@/components/list-row-skeleton";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { presentError } from "@/lib/error-summary";
import type { useGitLabWorkTodos } from "@/lib/git/queries/gitlab-work";
import type { WorkTodo } from "@/lib/git/types/gitlab-work";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { parseableDate } from "@/lib/time";
import { WorkItemMetadata } from "./WorkItemMetadata";

const keyOf = (todo: WorkTodo) => `${todo.host}:${todo.id}`;
const rowId = (todo: WorkTodo) =>
  `work-todo-${encodeURIComponent(keyOf(todo))}`;

export function WorkTodosList({
  query,
  connected,
  sourcesPending,
  filter,
  completing,
  completionNotice,
  onComplete,
  onRetry,
  onOpen,
}: {
  query: ReturnType<typeof useGitLabWorkTodos>;
  connected: boolean;
  sourcesPending: boolean;
  filter: string;
  completing: boolean;
  completionNotice: string | null;
  onComplete: (todo: WorkTodo) => void;
  onRetry: () => void;
  onOpen: (todo: WorkTodo) => void;
}) {
  const [active, setActive] = useState<string | null>(null);
  const q = filter.trim().toLowerCase();
  const rows = (query.data?.items ?? []).filter((todo) =>
    `${todo.title} ${todo.item?.repoFullName ?? ""} ${todo.host} ${todo.item?.number ?? ""}`
      .toLowerCase()
      .includes(q),
  );
  const index = rows.findIndex((todo) => keyOf(todo) === active);
  useHotkeyAction(
    "work-open-selected",
    () => {
      if (rows[index]) onOpen(rows[index]);
    },
    index >= 0,
  );
  useHotkeyAction(
    "work-complete-todo",
    () => {
      if (rows[index]) onComplete(rows[index]);
    },
    index >= 0 && !completing && !query.isPaused,
  );
  const arrows = listKeyboardNav({
    items: rows,
    activeIndex: index,
    ignoreTextEntry: true,
    onActivate: (todo) => {
      setActive(keyOf(todo));
      document.getElementById(rowId(todo))?.focus();
    },
  });
  if (sourcesPending || (connected && query.isPending && !query.isPaused))
    return <ListRowSkeletons rows={8} lines={1} name="to-dos" />;
  if (!connected)
    return (
      <p className="p-6 text-center text-xs text-muted-foreground">
        Connect GitLab in Settings → Accounts to see your to-dos.
      </p>
    );
  if (query.isError && !query.data)
    return (
      <div className="grid justify-items-center gap-3 p-6 text-xs">
        <p>{presentError(query.error).summary}</p>
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  if (query.isPaused && !query.data)
    return (
      <p className="p-6 text-center text-xs text-muted-foreground">
        Your to-dos will load when the connection returns.
      </p>
    );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {completionNotice && (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
          {completionNotice}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="p-6 text-center text-xs text-muted-foreground">
          {q
            ? "No to-dos match."
            : query.data?.truncated
              ? "Some to-dos could not be loaded."
              : "No pending to-dos."}
        </p>
      ) : (
        <div role="list" aria-label="GitLab to-dos" onKeyDown={arrows}>
          {rows.map((todo) => (
            <div
              role="listitem"
              key={keyOf(todo)}
              className="flex items-center gap-2 border-b px-3 py-2"
            >
              <button
                type="button"
                id={rowId(todo)}
                onClick={() => {
                  setActive(keyOf(todo));
                  onOpen(todo);
                }}
                className="min-w-0 flex-1 text-left text-xs focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span className="block truncate font-medium">{todo.title}</span>
                {todo.item && (
                  <span className="mt-1.5 block">
                    <WorkItemMetadata item={todo.item} />
                  </span>
                )}
                <span className="mt-1 flex gap-2 text-[11px] text-muted-foreground">
                  <span>{todo.action.replaceAll("_", " ")}</span>
                  <span className="truncate">
                    {todo.item?.repoFullName ?? todo.host}
                  </span>
                  <span>{todo.targetType}</span>
                  {parseableDate(todo.updatedAt) && (
                    <RelativeTime date={todo.updatedAt} />
                  )}
                </span>
              </button>
              <Button
                size="sm"
                variant="ghost"
                disabled={completing || query.isPaused}
                aria-label={`Mark complete: ${todo.title}`}
                onClick={() => onComplete(todo)}
              >
                <CheckIcon />
                Done
              </Button>
            </div>
          ))}
        </div>
      )}
      {query.data?.truncated && rows.length > 0 && (
        <p className="p-3 text-center text-[11px] text-muted-foreground">
          Some to-dos may be missing.
        </p>
      )}
      {query.isError && query.data && (
        <p role="status" className="p-3 text-xs text-muted-foreground">
          Couldn't refresh your to-dos. Showing the last loaded list.
        </p>
      )}
    </div>
  );
}
