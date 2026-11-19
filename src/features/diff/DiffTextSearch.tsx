import {
  ArrowDownIcon,
  ArrowUpIcon,
  MagnifyingGlassIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  type RefObject,
  useDeferredValue,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { usePanelActive } from "@/components/panel-portal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatBinding } from "@/lib/hotkeys/binding";
import { useEffectiveBindings, useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import { useDiffPaneHold } from "./diff-pane-hold";
import {
  type DiffTextMatch,
  findDiffText,
  highlightDiffMatches,
} from "./text-search";
import "./text-search.css";

/** One find bar for the staging renderer and every read-only diff layout. */
export function DiffTextSearch({
  contentRef,
}: {
  contentRef: RefObject<HTMLDivElement | null>;
}) {
  const { interactive } = useDiffPaneHold();
  const panelActive = usePanelActive();
  const enabled = interactive && panelActive;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [matchCase, setMatchCase] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [found, setFound] = useState<{
    query: string;
    matches: DiffTextMatch[];
    capped: boolean;
  }>({ query: "", matches: [], capped: false });
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const owner = useId();
  const bindings = useEffectiveBindings();
  const shortcut = bindings.get("find-in-diff") ?? bindings.get("focus-filter");
  const hint = shortcut ? formatBinding(shortcut) : undefined;
  if (!enabled && open) setOpen(false);

  function show() {
    if (
      !contentRef.current?.isConnected ||
      contentRef.current.closest('[inert],[hidden],[aria-hidden="true"]')
    )
      return;
    if (!open)
      previousFocus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    setOpen(true);
    inputRef.current?.focus();
    inputRef.current?.select();
  }
  function close() {
    setOpen(false);
    setFound({ query: "", matches: [], capped: false });
    if (previousFocus.current?.isConnected)
      previousFocus.current.focus({ preventScroll: true });
  }
  useHotkeyAction("find-in-diff", show, enabled);
  useSeedOnOpen(open && enabled, () => {
    inputRef.current?.focus();
    inputRef.current?.select();
  });
  useEffect(() => {
    const host = contentRef.current;
    if (!host || !open || !enabled) return;
    const read = () =>
      setFound({
        query: deferredQuery,
        ...findDiffText(host, deferredQuery, matchCase),
      });
    read();
    const observer = new MutationObserver(read);
    observer.observe(host, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["hidden", "inert", "aria-hidden"],
    });
    return () => observer.disconnect();
  }, [contentRef, open, enabled, deferredQuery, matchCase]);
  const matches = found.query === deferredQuery ? found.matches : [];
  const active = Math.min(cursor, Math.max(0, matches.length - 1));
  const highlighting =
    open && enabled && query !== "" && query === deferredQuery;
  useEffect(() => {
    if (!highlighting) return;
    const clear = highlightDiffMatches(owner, matches, active);
    matches[active]?.cell.scrollIntoView({
      block: "center",
      inline: "nearest",
    });
    return clear;
  }, [highlighting, owner, matches, active]);
  function step(direction: number) {
    if (matches.length)
      setCursor((active + direction + matches.length) % matches.length);
  }
  if (!open || !enabled) return null;
  const searching = query !== deferredQuery || found.query !== query;
  return (
    <div className="pointer-events-none sticky top-0 z-30 flex h-0 items-start justify-end">
      <div
        role="search"
        aria-label="Diff text search"
        className="ph-no-capture pointer-events-auto mr-2 mt-1 flex w-full max-w-96 min-w-0 items-center gap-1 border bg-popover p-1 text-popover-foreground shadow-md"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
      >
        <MagnifyingGlassIcon
          aria-hidden
          className="ml-1 size-3.5 shrink-0 text-muted-foreground"
        />
        <Input
          ref={inputRef}
          type="search"
          aria-label="Find in diff"
          placeholder="Find in diff"
          className="h-7 flex-1 border-0 px-1"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              step(event.shiftKey ? -1 : 1);
            }
          }}
        />
        <span
          role="status"
          className="shrink-0 text-[11px] text-muted-foreground"
          aria-live="polite"
        >
          {query === ""
            ? ""
            : searching
              ? "Searching…"
              : matches.length
                ? `${active + 1} of ${matches.length}${found.capped ? "+" : ""}`
                : "No matches"}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Match case"
          aria-pressed={matchCase}
          title="Match case"
          onClick={() => {
            setMatchCase((value) => !value);
            setCursor(0);
          }}
        >
          Aa
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Previous match"
          title="Previous match (Shift+Enter)"
          disabled={matches.length === 0 || searching}
          onClick={() => step(-1)}
        >
          <ArrowUpIcon aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Next match"
          title="Next match (Enter)"
          disabled={matches.length === 0 || searching}
          onClick={() => step(1)}
        >
          <ArrowDownIcon aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Close diff search"
          title={
            hint
              ? `Close diff search (Esc) · Find: ${hint}`
              : "Close diff search (Esc)"
          }
          onClick={close}
        >
          <XIcon aria-hidden />
        </Button>
      </div>
    </div>
  );
}
