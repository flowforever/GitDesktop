import { type KeyboardEvent, useId, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export function PrImportTargetPicker({
  specifier,
  paths,
  onChoose,
  onClose,
}: {
  specifier: string;
  paths: readonly string[];
  onChoose: (path: string) => void;
  onClose: () => void;
}) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const matches = paths.filter((path) =>
    path.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const selected = Math.min(cursor, matches.length - 1);
  function move(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (matches[selected]) onChoose(matches[selected]);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (matches.length === 0) return;
      const next = Math.max(
        0,
        Math.min(
          matches.length - 1,
          selected + (event.key === "ArrowDown" ? 1 : -1),
        ),
      );
      setCursor(next);
      document
        .getElementById(`${listId}-${next}`)
        ?.scrollIntoView?.({ block: "nearest" });
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Choose an import target</DialogTitle>
          <DialogDescription>
            <span className="break-all font-mono">{specifier}</span> has
            multiple source files. Choose a file to open.
          </DialogDescription>
        </DialogHeader>
        <Input
          role="combobox"
          aria-label="Filter import targets"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={
            matches[selected] ? `${listId}-${selected}` : undefined
          }
          placeholder="Filter files…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          onKeyDown={move}
        />
        <div
          id={listId}
          role="listbox"
          aria-label="Import target files"
          className="max-h-80 overflow-auto border"
        >
          {matches.length === 0 ? (
            <p className="p-4 text-center text-sm text-muted-foreground">
              No matching files
            </p>
          ) : (
            matches.map((path, index) => (
              <button
                id={`${listId}-${index}`}
                key={path}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index === selected}
                onMouseMove={() => setCursor(index)}
                onClick={() => onChoose(path)}
                className={`block min-w-full cursor-pointer px-3 py-2 text-left font-mono text-xs whitespace-nowrap outline-none ${index === selected ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
              >
                {path}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
