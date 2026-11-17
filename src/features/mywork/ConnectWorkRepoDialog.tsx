import { open as openDirectory } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CloneRepoDialog } from "@/features/welcome/CloneRepoDialog";
import { repoOriginPath, validateRepo } from "@/lib/git/api";
import type { MyWorkItem, RepoInfo } from "@/lib/git/types";
import type { RecentRepo } from "@/lib/settings/api";
import { useAddRecentRepo } from "@/lib/settings/queries";
import { toastError } from "@/lib/toast";

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
  const addRecent = useAddRecentRepo();
  async function connect(
    info: RepoInfo,
    stillValid: () => boolean = () => true,
  ) {
    const origin = await repoOriginPath(info.root);
    if (!stillValid()) return;
    if (
      origin.host?.toLowerCase() !== item.host.toLowerCase() ||
      origin.path?.toLowerCase() !== item.repoFullName.toLowerCase() ||
      origin.provider !== "gitlab"
    ) {
      throw new Error(
        `Choose a checkout of ${item.host}/${item.repoFullName}.`,
      );
    }
    await addRecent.mutateAsync({ path: info.root, name: info.name });
    if (!stillValid()) return;
    await onConnected(
      {
        path: info.root,
        name: info.name,
        host: item.host,
        owner: item.repoOwner,
        repoName: item.repoName,
        provider: item.provider,
        lastOpenedAt: new Date().toISOString(),
      },
      stillValid,
    );
  }
  if (cloning)
    return (
      <CloneRepoDialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        target={{
          provider: "gitlab",
          cloneUrl: `${new URL(item.url).origin}/${item.repoFullName}.git`,
          name: item.repoName,
        }}
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
              setPicking(true);
              void (async () => {
                const path = await openDirectory({
                  directory: true,
                  multiple: false,
                });
                if (typeof path === "string")
                  await connect(await validateRepo(path));
              })()
                .catch(toastError)
                .finally(() => setPicking(false));
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
