import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import {
  Fragment,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { usePanelActive } from "@/components/panel-portal";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { literalSearchPattern } from "@/features/diff/text-search";
import {
  LAYOUT_COMPOSER_HELD,
  lineComposerOpen,
} from "@/features/diff/whitespace-mode";
import { useCloseSettled } from "@/features/repository/publish-confirm";
import { formatBinding } from "@/lib/hotkeys/binding";
import { useEffectiveBindings, useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { useUiStore } from "@/lib/stores/ui";
import { useLatestRef } from "@/lib/use-latest-ref";
import { type PrDiffSearchMatch, searchPrDiffs } from "./pr-diff-search";

function SearchSnippet({
  text,
  query,
  matchCase,
}: {
  text: string;
  query: string;
  matchCase: boolean;
}) {
  const pattern = literalSearchPattern(query, matchCase);
  if (!pattern) return text;
  const parts = [];
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    parts.push(text.slice(end, match.index));
    parts.push(
      <mark key={match.index} className="bg-warning/30 text-foreground">
        {match[0]}
      </mark>,
    );
    end = match.index + match[0].length;
  }
  parts.push(text.slice(end));
  return parts;
}

/** Search the MR patch already loaded by the view, independent of AI settings. */
export function PrDiffSearch({
  sections,
  enabled,
  pending,
  failed,
  paused = false,
  incomplete,
  onRetry,
  onSelect,
}: {
  sections: ReadonlyMap<string, string>;
  enabled: boolean;
  pending: boolean;
  failed: boolean;
  paused?: boolean;
  incomplete: boolean;
  onRetry: () => void;
  onSelect: (match: PrDiffSearchMatch) => void | boolean;
}) {
  const panelActive = usePanelActive();
  const available = enabled && panelActive;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [active, setActive] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectionVersion = useRef(0);
  const live = useLatestRef({ available, onSelect });
  const closing = useCloseSettled(open && available);
  useEffect(() => {
    if (!available) selectionVersion.current++;
    return () => {
      selectionVersion.current++;
    };
  }, [available]);
  const deferredQuery = useDeferredValue(query);
  if (!available && open) setOpen(false);
  const results = useMemo(
    () =>
      searchPrDiffs(
        open && available && !pending ? sections : new Map(),
        deferredQuery,
        matchCase,
      ),
    [open, available, pending, sections, deferredQuery, matchCase],
  );
  const index = Math.min(active, results.matches.length - 1);
  const bindings = useEffectiveBindings();
  const binding =
    bindings.get("search-pr-changes") ?? bindings.get("show-in-explorer");
  const hint = binding ? formatBinding(binding) : null;
  function show() {
    if (
      !open &&
      triggerRef.current?.closest('[inert],[hidden],[aria-hidden="true"]')
    )
      return;
    if (lineComposerOpen()) {
      toast.info(LAYOUT_COMPOSER_HELD);
      return;
    }
    selectionVersion.current++;
    setOpen(true);
  }
  async function choose(match: PrDiffSearchMatch) {
    if (!available || query !== deferredQuery) return;
    const version = ++selectionVersion.current;
    const epoch = useUiStore.getState().interactionEpoch;
    setOpen(false);
    // A cached file can settle before the dialog releases its modal/focus hold.
    await closing.waitClosed();
    if (
      selectionVersion.current !== version ||
      !live.current.available ||
      useUiStore.getState().interactionEpoch !== epoch
    )
      return;
    if (live.current.onSelect(match) === false) setOpen(true);
  }
  useHotkeyAction("search-pr-changes", show, available);
  const navigation = listKeyboardNav({
    items: results.matches,
    activeIndex: index,
    onActivate: (_match, to) => setActive(to),
    rowKey: (match) => String(results.matches.indexOf(match)),
    rowAttr: "data-search-result",
  });
  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="icon-xs"
        aria-label="Search MR changes"
        title={hint ? `Search MR changes (${hint})` : "Search MR changes"}
        disabled={!available}
        onClick={show}
      >
        <MagnifyingGlassIcon aria-hidden />
      </Button>
      <Dialog
        open={open && available}
        onOpenChange={(next) => {
          selectionVersion.current++;
          setOpen(next);
        }}
        onOpenChangeComplete={closing.onOpenChangeComplete}
      >
        <DialogContent
          className="ph-no-capture flex max-h-[80vh] min-h-0 flex-col gap-3 sm:max-w-2xl"
          onKeyDown={navigation}
        >
          <DialogHeader>
            <DialogTitle>Search MR changes</DialogTitle>
            <DialogDescription>
              Find text across added, removed and context lines in this MR's
              diffs.
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-w-0 items-center gap-2">
            <Input
              type="search"
              aria-label="Search MR changes"
              placeholder="Search all changed files"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(-1);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  const match = results.matches[Math.max(0, index)];
                  if (match) {
                    event.preventDefault();
                    choose(match);
                  }
                }
              }}
            />
            <Button
              variant={matchCase ? "secondary" : "ghost"}
              size="xs"
              aria-label="Match case"
              aria-pressed={matchCase}
              onClick={() => {
                setMatchCase((value) => !value);
                setActive(-1);
              }}
            >
              Aa
            </Button>
          </div>
          {incomplete && (
            <p role="status" className="text-xs text-muted-foreground">
              Some file diffs are unavailable. Results may be incomplete.
            </p>
          )}
          {failed && (
            <div role="status" className="flex items-center gap-2 text-xs">
              <span>Could not load MR diffs.</span>
              <Button variant="outline" size="xs" onClick={onRetry}>
                Retry
              </Button>
            </div>
          )}
          <div
            role="status"
            aria-live="polite"
            className="text-xs text-muted-foreground"
          >
            {paused
              ? "MR diffs will load when you're back online."
              : pending
                ? "Loading MR diffs…"
                : query !== deferredQuery
                  ? "Searching…"
                  : !query
                    ? "Enter text to search the MR's diffs."
                    : results.total
                      ? `${results.total} matching ${results.total === 1 ? "line" : "lines"} in ${results.files} ${results.files === 1 ? "file" : "files"}`
                      : failed
                        ? ""
                        : "No matches"}
          </div>
          {results.total > results.matches.length && (
            <p className="text-xs text-muted-foreground">
              Showing the first {results.matches.length} matching lines. Narrow
              the search to see more.
            </p>
          )}
          <div
            className="ph-no-capture min-h-0 overflow-auto border-t"
            aria-label="MR search results"
            aria-busy={query !== deferredQuery || pending}
          >
            {results.matches.map((match, row) => (
              <Fragment key={`${match.path}:${match.side}:${match.line}`}>
                {(row === 0 ||
                  results.matches[row - 1].path !== match.path) && (
                  <p className="break-all bg-muted/40 px-2 py-2 font-mono text-xs font-medium">
                    {match.path}
                  </p>
                )}
                <button
                  type="button"
                  data-search-result={row}
                  tabIndex={
                    index === row || (index === -1 && row === 0) ? 0 : -1
                  }
                  onFocus={() => setActive(row)}
                  onClick={() => choose(match)}
                  aria-label={`${match.path}, ${match.side === "old" ? "Before" : "After"} line ${match.line}: ${match.text}`}
                  className="flex w-full min-w-0 items-start gap-3 border-b px-2 py-2 text-left font-mono text-xs hover:bg-muted/50 focus-visible:bg-accent focus-visible:outline-none"
                >
                  <span className="w-24 shrink-0 text-muted-foreground">
                    {match.side === "old" ? "Before" : "After"} · {match.line}
                  </span>
                  <span className="min-w-0 whitespace-pre-wrap break-all">
                    <SearchSnippet
                      text={match.text}
                      query={deferredQuery}
                      matchCase={matchCase}
                    />
                  </span>
                </button>
              </Fragment>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
