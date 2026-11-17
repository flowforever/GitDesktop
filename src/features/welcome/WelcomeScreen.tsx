import {
  BookOpenIcon,
  CompassIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  GearIcon,
  GitForkIcon,
  QuestionIcon,
  TrayIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useUpdateCheck } from "@/features/updates/useUpdateCheck";
import { formatBinding } from "@/lib/hotkeys/binding";
import { dispatchAction, useEffectiveBindings } from "@/lib/hotkeys/hotkeys";
import type { ActionId } from "@/lib/hotkeys/registry";
import { useSaveSettings, useSettings } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { cn } from "@/lib/utils";
import { RecentRepoList } from "./RecentRepoList";

export function WelcomeScreen() {
  const openSettings = useUiStore((s) => s.openSettings);
  const openHelp = useUiStore((s) => s.openHelp);
  const openExplore = useUiStore((s) => s.openExplore);
  const openMyWork = useUiStore((s) => s.openMyWork);
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const bindings = useEffectiveBindings();
  const updateAvailable = Boolean(useUpdateCheck().data);

  function dismissNudge() {
    if (settings.data) {
      saveSettings.mutate({ ...settings.data, seenGuideNudge: true });
    }
  }
  function openGuide() {
    dismissNudge();
    openHelp();
  }

  // The primary entry points, surfaced as a launcher: label on the left, the
  // live keyboard shortcut on the right (honours user remaps via bindings).
  const actions: {
    id: ActionId;
    label: string;
    icon: typeof FolderOpenIcon;
    variant: "default" | "ghost";
    group: "repository" | "navigation";
    onClick: () => void;
  }[] = [
    {
      id: "add-local-repository",
      label: "Open repository",
      icon: FolderOpenIcon,
      variant: "default",
      group: "repository",
      onClick: () => dispatchAction("add-local-repository"),
    },
    {
      id: "clone-repository",
      label: "Clone repository",
      icon: GitForkIcon,
      variant: "ghost",
      group: "repository",
      onClick: () => dispatchAction("clone-repository"),
    },
    {
      id: "new-repository",
      label: "Create repository",
      icon: FolderPlusIcon,
      variant: "ghost",
      group: "repository",
      onClick: () => dispatchAction("new-repository"),
    },
    // Navigation stays quieter than the repository entry points.
    {
      id: "open-my-work",
      label: "My works",
      icon: TrayIcon,
      variant: "ghost",
      group: "navigation",
      onClick: openMyWork,
    },
    {
      id: "open-explore",
      label: "Explore repositories",
      icon: CompassIcon,
      variant: "ghost",
      group: "navigation",
      onClick: openExplore,
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* overflow-hidden contains the content's natural height (vendored Root is
          `relative`-only), so a tall welcome pane can't leak a window scrollbar. */}
      <ScrollArea className="min-h-0 flex-1 overflow-hidden">
        <main className="flex min-h-full w-full flex-col p-4 sm:p-6 md:h-full">
          <h1 className="sr-only">Repositories</h1>
          <div
            aria-busy={settings.isPending}
            className="flex min-h-0 flex-1 flex-col gap-4"
          >
            {!settings.isPending && (
              <>
                {settings.data && !settings.data.seenGuideNudge && (
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border bg-muted/40 px-3 py-2">
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <BookOpenIcon className="size-4 shrink-0 text-foreground" />
                      Get familiar with GitDesktop in the built-in guide.
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      <Button size="xs" variant="ghost" onClick={dismissNudge}>
                        Dismiss
                      </Button>
                      <Button size="xs" onClick={openGuide}>
                        Open guide
                      </Button>
                    </span>
                  </div>
                )}

                <div className="grid items-start gap-4 md:min-h-0 md:flex-1 md:grid-cols-[minmax(0,1fr)_18rem] md:grid-rows-[minmax(0,1fr)] lg:gap-6">
                  <section
                    aria-label="Repositories"
                    className="min-w-0 md:flex md:min-h-0 md:flex-col md:self-stretch"
                  >
                    <RecentRepoList fillHeight />
                  </section>

                  <aside
                    aria-label="Repository actions"
                    className="min-w-0 space-y-2"
                  >
                    <div className="flex min-h-6 items-center justify-between gap-2 px-1">
                      <h2 className="font-heading text-sm font-medium">
                        Repository actions
                      </h2>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label="User guide"
                          title="User guide (F1)"
                          onClick={openHelp}
                        >
                          <QuestionIcon />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="relative"
                          aria-label={
                            updateAvailable
                              ? "Settings — update available"
                              : "Settings"
                          }
                          title={
                            updateAvailable
                              ? "Settings — update available"
                              : "Settings"
                          }
                          onClick={() => openSettings()}
                        >
                          <GearIcon />
                          {updateAvailable && (
                            <span
                              aria-hidden
                              className="absolute top-1 right-1 size-1.5 rounded-full bg-primary ring-2 ring-background animate-in fade-in motion-reduce:animate-none"
                            />
                          )}
                        </Button>
                      </div>
                    </div>

                    <div className="border bg-muted/20 p-3">
                      {(["repository", "navigation"] as const).map((group) => (
                        <div
                          key={group}
                          className={cn(
                            "space-y-1",
                            group === "navigation" && "mt-3 border-t pt-3",
                          )}
                        >
                          {actions
                            .filter((action) => action.group === group)
                            .map(
                              ({ id, label, icon: Icon, variant, onClick }) => {
                                const binding = bindings.get(id);
                                return (
                                  <Button
                                    key={id}
                                    variant={variant}
                                    size="sm"
                                    onClick={onClick}
                                    className={cn(
                                      "h-auto min-h-9 w-full justify-between gap-3 px-3 py-2",
                                      group === "navigation" &&
                                        "text-muted-foreground hover:text-foreground",
                                    )}
                                  >
                                    <span className="flex min-w-0 items-center gap-2 text-left whitespace-normal">
                                      <Icon
                                        aria-hidden
                                        className="size-4 shrink-0"
                                      />
                                      {label}
                                    </span>
                                    {binding && (
                                      <kbd
                                        className={cn(
                                          "shrink-0 font-mono text-[11px] font-normal tabular-nums",
                                          variant !== "default" &&
                                            "text-muted-foreground",
                                        )}
                                      >
                                        {formatBinding(binding)}
                                      </kbd>
                                    )}
                                  </Button>
                                );
                              },
                            )}
                        </div>
                      ))}
                      <p className="px-3 pt-4 text-[11px]/relaxed text-muted-foreground">
                        Drop a repository folder anywhere to open it.
                      </p>
                    </div>
                  </aside>
                </div>
              </>
            )}
          </div>
        </main>
      </ScrollArea>
    </div>
  );
}
