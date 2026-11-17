import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useSaveSettingsPatch } from "@/lib/settings/queries";
import { toastError } from "@/lib/toast";

export function TeamLabelsDialog({
  labels,
  onClose,
}: {
  labels: readonly string[];
  onClose: () => void;
}) {
  const [text, setText] = useState(labels.join("\n"));
  const save = useSaveSettingsPatch();
  const next = [
    ...new Set(
      text
        .split("\n")
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
  const invalid =
    next.length > 6
      ? "Choose up to six labels."
      : next.some((v) => v.includes(",") || /^(any|none)$/i.test(v))
        ? "Use literal label names without commas. GitLab reserves Any and None."
        : null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !save.isPending) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Team merge request labels</DialogTitle>
          <DialogDescription>
            Enter one label per line. Merge requests matching any label appear
            across all your GitLab instances.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (invalid || save.isPending) return;
            void save
              .mutateAsync({ myWorkTeamLabels: next })
              .then(onClose)
              .catch(toastError);
          }}
          className="space-y-4"
        >
          <label className="grid gap-2 text-xs">
            Labels
            <Textarea
              autoFocus
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={"team::frontend\nteam::platform"}
              rows={6}
              aria-invalid={!!invalid}
              aria-describedby="team-label-help"
            />
          </label>
          <p id="team-label-help" className="text-xs text-muted-foreground">
            {invalid ??
              "Leave empty to clear the team filter. Your other settings stay unchanged."}
          </p>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={save.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!!invalid || save.isPending}>
              {save.isPending ? "Saving…" : "Save labels"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
