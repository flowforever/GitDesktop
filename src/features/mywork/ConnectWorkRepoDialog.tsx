import { open as openDirectory } from "@tauri-apps/plugin-dialog";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { claimRepoOpen } from "@/features/repository/useOpenRepoByPath";
import { CloneRepoDialog } from "@/features/welcome/CloneRepoDialog";
import { repoOriginPath, validateRepo } from "@/lib/git/api";
import type { MyWorkItem, RepoInfo } from "@/lib/git/types";
import type { RecentRepo } from "@/lib/settings/api";
import { useAddRecentRepo } from "@/lib/settings/queries";
import { toastError } from "@/lib/toast";
import { workRepoOriginMatches, workRepoRecent } from "./work-repo-checkout";

export function ConnectWorkRepoDialog({
  item,
  onClose,
  onConnected,
}: {
  item: MyWorkItem;
  onClose: () => void;
  onConnected: (repo: RecentRepo, stillValid: () => boolean) => Promise<void>;
}) {
  const [cloning, setCloning] = useState(false);
  const [picking, setPicking] = useState(false);
  const connectionOwner = useRef<object | null>(null);
  const addRecent = useAddRecentRepo();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new MR identity retires the previous dialog's proof.
  useLayoutEffect(() => {
    const owner = {};
    connectionOwner.current = owner;
    setPicking(false);
    setCloning(false);
    return () => {
      connectionOwner.current = null;
    };
  }, [item.provider, item.host, item.repoFullName, item.number, item.url]);

  async function connect(info: RepoInfo, stillValid: () => boolean) {
    const owner = connectionOwner.current;
    const valid = () =>
      owner !== null && owner === connectionOwner.current && stillValid();
    if (!valid()) return;
    const origin = await repoOriginPath(info.root);
    if (!valid()) return;
    if (!workRepoOriginMatches(item, origin)) {
      throw new Error(
        `Choose a checkout of ${item.host}/${item.repoFullName}.`,
      );
    }
    const recent = workRepoRecent(item, info);
    await addRecent.mutateAsync(recent);
    if (!valid()) return;
    await onConnected(recent, valid);
  }
  if (cloning)
    return (
      <CloneRepoDialog
        key={item.url}
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        target={{
          provider: item.provider,
          cloneUrl: `${new URL(item.url).origin}/${item.repoFullName}.git`,
          name: item.repoName,
        }}
        reuseFor={item}
        onCloned={connect}
      />
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !picking) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect a local repository</DialogTitle>
          <DialogDescription>
            Open the full MR detail for {item.repoFullName} using an existing
            checkout or a new clone.
          </DialogDescription>
        </DialogHeader>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {item.host}/{item.repoFullName} !{item.number}
        </p>
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            disabled={picking}
            onClick={() => {
              const owner = connectionOwner.current;
              const claimed = claimRepoOpen();
              const stillValid = () =>
                owner !== null &&
                owner === connectionOwner.current &&
                claimed();
              setPicking(true);
              void (async () => {
                const path = await openDirectory({
                  directory: true,
                  multiple: false,
                });
                if (typeof path !== "string" || !stillValid()) return;
                const info = await validateRepo(path);
                if (!stillValid()) return;
                await connect(info, stillValid);
              })()
                .catch((error) => {
                  if (stillValid()) toastError(error);
                })
                .finally(() => {
                  if (owner === connectionOwner.current) setPicking(false);
                });
            }}
          >
            {picking ? "Opening…" : "Choose local repository"}
          </Button>
          <Button disabled={picking} onClick={() => setCloning(true)}>
            Clone repository
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
