import { getIdentifier } from "@tauri-apps/api/app";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { isMac } from "@/lib/hotkeys/binding";

type InstallState = "available" | "installing" | "installed" | "failed";

// A dismissed version stays dismissed for automatic checks in this app
// session, including a remount. An explicit manual check can show it again.
const dismissedVersions = new Set<string>();

function closeUpdate(update: Update) {
  void update.close().catch(() => undefined);
}

// Mounted only by the signed preview build. The stable app and unsigned CI
// artifacts keep the upstream behavior of making no startup update requests.
export function PreviewUpdateNotice({
  forkStable = false,
}: {
  forkStable?: boolean;
}) {
  const name = forkStable ? "GitDesktop Flowforever" : "GitDesktop Preview";
  const [eligible, setEligible] = useState(false);
  const [version, setVersion] = useState("");
  const [open, setOpen] = useState(false);
  const [installState, setInstallState] = useState<InstallState>("available");
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState("");
  const mounted = useRef(false);
  const pending = useRef(false);
  const resource = useRef<Update | null>(null);
  const installing = useRef(false);
  const later = useRef<HTMLButtonElement>(null);
  const checkButton = useRef<HTMLButtonElement>(null);

  const checkForUpdate = useCallback(
    async (manual: boolean) => {
      if (!mounted.current || pending.current || resource.current) return;
      pending.current = true;
      setChecking(true);
      setMessage("");
      try {
        const candidate = await check({ timeout: 10_000 });
        if (!candidate) {
          if (manual && mounted.current)
            setMessage(
              forkStable
                ? "No update is available."
                : "No preview update is available.",
            );
          return;
        }
        if (
          !mounted.current ||
          (!manual && dismissedVersions.has(candidate.version))
        ) {
          closeUpdate(candidate);
          return;
        }
        resource.current = candidate;
        setInstallState("available");
        setVersion(candidate.version);
        setOpen(true);
      } catch {
        // An offline or unavailable update feed never blocks startup.
        if (manual && mounted.current)
          setMessage("Could not check for updates. Try again.");
      } finally {
        pending.current = false;
        if (mounted.current) setChecking(false);
      }
    },
    [forkStable],
  );

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    mounted.current = true;
    void getIdentifier()
      .then((identifier) => {
        if (
          active &&
          (forkStable
            ? identifier === "io.github.flowforever.gitdesktop"
            : identifier === "com.thebguy.gitdesktop.preview" ||
              identifier === "com.thebguy.gitdesktop.preview.staging")
        ) {
          setEligible(true);
          void checkForUpdate(false);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
      mounted.current = false;
      if (resource.current) closeUpdate(resource.current);
      resource.current = null;
    };
  }, [checkForUpdate, forkStable]);

  const dismiss = () => {
    const candidate = resource.current;
    if (!candidate) return;
    dismissedVersions.add(candidate.version);
    closeUpdate(candidate);
    resource.current = null;
    setOpen(false);
  };

  const install = async () => {
    const update = resource.current;
    if (!update || installing.current) return;
    installing.current = true;
    setInstallState("installing");
    try {
      // Tauri verifies the signed bytes and the signed version. Do not bypass
      // the plugin to fetch a URL from the update feed manually.
      if (isMac) {
        const quitting = await invoke<boolean>("preview_open_signed_dmg", {
          expectedVersion: update.version,
        });
        if (!mounted.current) return;
        // The macOS quit guard may open its own confirmation for parked writes.
        // Close this dialog so it doesn't compete with that confirmation.
        dismiss();
        setMessage(
          quitting
            ? `Disk image opened. Quitting ${name}…`
            : `Disk image opened. Quit ${name} before replacing it in Applications.`,
        );
      } else {
        await update.downloadAndInstall(undefined, {
          restartAfterInstall: false,
          timeout: 120_000,
        });
        if (mounted.current) setInstallState("installed");
      }
    } catch {
      if (mounted.current) setInstallState("failed");
    } finally {
      installing.current = false;
    }
  };

  if (!eligible) return null;
  return (
    <>
      <div className="flex shrink-0 items-center justify-end gap-2 border-b px-2 py-1">
        <span role="status" className="text-xs text-muted-foreground">
          {message}
        </span>
        <Button
          ref={checkButton}
          variant="ghost"
          size="xs"
          disabled={checking}
          onClick={() => void checkForUpdate(true)}
        >
          {checking ? "Checking for updates…" : "Check for updates"}
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={(open, details) => {
          if (open) return;
          if (installing.current) details.cancel();
          else dismiss();
        }}
      >
        <DialogContent
          aria-label={`${name} update`}
          initialFocus={() => later.current}
          finalFocus={() => checkButton.current}
          showCloseButton={false}
        >
          <DialogHeader>
            <DialogTitle>{name} update</DialogTitle>
            <DialogDescription>
              {name} {version} is available.
              {isMac &&
                ` The app will download and verify the disk image, open it, then quit so you can replace it in Applications. This ${forkStable ? "build" : "preview"} is not Apple-notarized.`}
            </DialogDescription>
          </DialogHeader>
          {installState !== "available" && (
            <p role="status">
              {installState === "installing"
                ? isMac
                  ? "Downloading and verifying the disk image…"
                  : "Downloading and installing the update…"
                : installState === "installed"
                  ? `Update installed. Restart ${name} to use it.`
                  : isMac
                    ? "The disk image could not be verified or opened. You can try again."
                    : "The update could not be installed. You can try again."}
            </p>
          )}
          <DialogFooter>
            <Button
              ref={later}
              variant="outline"
              size="sm"
              disabled={installState === "installing"}
              onClick={dismiss}
            >
              {installState === "installed" ? "Close" : "Later"}
            </Button>
            {(installState === "available" || installState === "failed") && (
              <Button size="sm" onClick={() => void install()}>
                {installState === "available" ? "Download update" : "Try again"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
