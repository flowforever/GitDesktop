import { getIdentifier } from "@tauri-apps/api/app";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { isMac } from "@/lib/hotkeys/binding";

type InstallState = "available" | "installing" | "installed" | "failed";

// Mounted only by the signed preview build. The stable app and unsigned CI
// artifacts keep the upstream behavior of making no startup update requests.
export function PreviewUpdateNotice() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [installState, setInstallState] = useState<InstallState>("available");
  const installing = useRef(false);

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let resource: Update | null = null;
    const close = (candidate: Update) => {
      void candidate.close().catch(() => undefined);
    };
    void getIdentifier()
      .then((identifier) =>
        active &&
        (identifier === "com.thebguy.gitdesktop.preview" ||
          identifier === "com.thebguy.gitdesktop.preview.staging")
          ? check({ timeout: 10_000 })
          : null,
      )
      .then((candidate) => {
        if (!candidate) return;
        if (!active) {
          close(candidate);
          return;
        }
        resource = candidate;
        setUpdate(candidate);
      })
      .catch(() => {
        // An offline or unavailable update feed never blocks startup.
      });
    return () => {
      active = false;
      if (resource) close(resource);
    };
  }, []);

  const install = async () => {
    if (!update || installing.current) return;
    installing.current = true;
    setInstallState("installing");
    try {
      // With requireSignedVersion enabled, Tauri verifies the signed bytes
      // and compares the signed version to the feed before installation.
      // Do not bypass the plugin to fetch the URL manually.
      if (isMac) {
        await invoke("preview_open_signed_dmg", {
          expectedVersion: update.version,
        });
      } else {
        await update.downloadAndInstall(undefined, {
          restartAfterInstall: false,
          timeout: 120_000,
        });
      }
      setInstallState("installed");
    } catch {
      setInstallState("failed");
    } finally {
      installing.current = false;
    }
  };

  if (!update) return null;
  return (
    <section
      aria-label="GitDesktop Preview update"
      className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-muted px-3 py-2 text-sm"
    >
      <span aria-live="polite">
        {installState === "installing"
          ? isMac
            ? "Downloading and verifying the disk image…"
            : "Downloading and installing the update…"
          : installState === "installed"
            ? isMac
              ? "Disk image opened. Quit GitDesktop Preview and replace it in Applications to finish. macOS may warn because this preview is not Apple-notarized."
              : "Update installed. Restart GitDesktop Preview to use it."
            : installState === "failed"
              ? isMac
                ? "The disk image could not be verified or opened. You can try again."
                : "The update could not be installed. You can try again."
              : `GitDesktop Preview ${update.version} is available.`}
      </span>
      {(installState === "available" || installState === "failed") && (
        <Button size="sm" onClick={() => void install()}>
          {installState === "available"
            ? isMac
              ? "Download and open disk image"
              : "Download and install"
            : "Try again"}
        </Button>
      )}
    </section>
  );
}
