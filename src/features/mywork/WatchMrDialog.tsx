import { useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useWatchGitLabMergeRequest } from "@/lib/git/queries/gitlab-work";
import { useRovingRows } from "@/lib/list-keyboard-nav";
import { isOfflineNow, useOfflineHold } from "@/lib/offline-writes";
import type { AppSettings } from "@/lib/settings/api";
import {
  settingsKeys,
  useSaveSettingsPatch,
  useSettings,
} from "@/lib/settings/queries";
import { errorMessage } from "@/lib/tauri/invoke";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";

const WATCH_LIMIT = 100;

export function WatchMrDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const running = useRef(false);
  const session = useRef<object | null>(null);
  const summary = useRef<HTMLElement | null>(null);
  const inputId = useId();
  const helpId = useId();
  const errorId = useId();
  const settings = useSettings();
  const client = useQueryClient();
  const watch = useWatchGitLabMergeRequest();
  const save = useSaveSettingsPatch();
  const offlineHold = useOfflineHold();
  const watched = settings.data?.myWorkWatchedMergeRequests ?? [];
  const watchedRows = useRovingRows({
    items: watched,
    rowKey: (value) => value,
  });

  useSeedOnOpen(open, () => {
    session.current = {};
    setUrl("");
    setError(null);
  });

  const pendingReason = removing
    ? "Removing this watched merge request…"
    : "Watching this merge request…";
  const holdReason = pending
    ? pendingReason
    : (offlineHold ??
      (settings.data === undefined
        ? "Wait for your watched merge requests to load."
        : !url.trim()
          ? "Paste a GitLab merge request URL."
          : undefined));

  async function submit() {
    if (running.current || !url.trim() || !settings.data || isOfflineNow())
      return;
    const owner = session.current;
    running.current = true;
    setPending(true);
    setError(null);
    try {
      const resolved = await watch.mutateAsync(url.trim());
      if (resolved.state === "closed") {
        throw new Error(
          "This merge request is closed. Choose an open or merged merge request.",
        );
      }
      const current = client.getQueryData<AppSettings>(settingsKeys.settings);
      if (!current)
        throw new Error(
          "Couldn't load your watched merge requests. Try again.",
        );
      const watched = current.myWorkWatchedMergeRequests;
      const canonical = resolved.item.url;
      if (!watched.includes(canonical)) {
        if (watched.length >= WATCH_LIMIT) {
          throw new Error(
            "You can watch up to 100 merge requests. Stop watching another request below before adding one.",
          );
        }
        await save.mutateAsync({
          myWorkWatchedMergeRequests: [...watched, canonical],
        });
      }
      if (session.current === owner) {
        session.current = null;
        onOpenChange(false);
      }
    } catch (cause) {
      if (session.current === owner) setError(errorMessage(cause));
    } finally {
      running.current = false;
      setPending(false);
    }
  }

  async function stopWatching(target: string) {
    if (running.current) return;
    const owner = session.current;
    const focused = document.activeElement;
    running.current = true;
    setPending(true);
    setRemoving(target);
    setError(null);
    try {
      const current = client.getQueryData<AppSettings>(settingsKeys.settings);
      if (!current)
        throw new Error(
          "Couldn't load your watched merge requests. Try again.",
        );
      const next = current.myWorkWatchedMergeRequests.filter(
        (value) => value !== target,
      );
      if (next.length !== current.myWorkWatchedMergeRequests.length) {
        await save.mutateAsync({ myWorkWatchedMergeRequests: next });
      }
      if (
        session.current === owner &&
        (document.activeElement === focused ||
          document.activeElement === document.body)
      )
        summary.current?.focus();
    } catch (cause) {
      if (session.current === owner) setError(errorMessage(cause));
    } finally {
      running.current = false;
      setPending(false);
      setRemoving(null);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (running.current) return;
        if (!next) session.current = null;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Watch MR</DialogTitle>
            <DialogDescription>
              Add a GitLab merge request to My Merge Requests. Merged requests
              stay in the Merged list; closed requests leave the list.
            </DialogDescription>
          </DialogHeader>
          <label htmlFor={inputId} className="grid gap-2 text-xs">
            Merge request URL
            <Input
              id={inputId}
              autoFocus
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setError(null);
              }}
              readOnly={pending}
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="https://gitlab.example.com/group/repo/-/merge_requests/42"
              aria-describedby={error ? `${helpId} ${errorId}` : helpId}
            />
          </label>
          <p id={helpId} className="text-xs text-muted-foreground">
            Paste the merge request link from a GitLab host you're signed in to.
          </p>
          {error && (
            <p id={errorId} role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <details className="border px-3">
            <summary
              ref={summary}
              className="cursor-pointer py-2 text-xs font-medium"
            >
              Watched merge requests ({watched.length})
            </summary>
            {watched.length > 0 ? (
              <ul
                className="max-h-48 overflow-y-auto"
                onKeyDown={watchedRows.onRowKeyDown}
              >
                {watched.map((savedUrl) => (
                  <li
                    key={savedUrl}
                    className="flex items-start gap-2 border-t py-2"
                  >
                    <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-muted-foreground">
                      {savedUrl}
                    </span>
                    <DisabledReasonButton
                      {...watchedRows.rowProps(savedUrl)}
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={pending}
                      reason={pendingReason}
                      aria-label={`Stop watching ${savedUrl}`}
                      onClick={() => void stopWatching(savedUrl)}
                    >
                      Stop watching
                    </DisabledReasonButton>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="border-t py-2 text-xs text-muted-foreground">
                No saved watches.
              </p>
            )}
          </details>
          <DialogFooter>
            <DisabledReasonButton
              type="button"
              variant="outline"
              disabled={pending}
              reason="Wait for this merge request to finish saving."
              onClick={() => {
                session.current = null;
                onOpenChange(false);
              }}
            >
              Cancel
            </DisabledReasonButton>
            <DisabledReasonButton
              type="submit"
              disabled={!!holdReason}
              reason={holdReason}
              aria-busy={pending}
            >
              {pending && <Spinner data-icon="inline-start" />}
              Watch MR
            </DisabledReasonButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
