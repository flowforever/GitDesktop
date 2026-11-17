import { ArrowDownIcon, ArrowUpIcon } from "@phosphor-icons/react";
import { type RefObject, useEffect, useState } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { useUiStore } from "@/lib/stores/ui";

type SourceAnchor = { side: "old" | "new"; line: number };
type Change = { line: number; anchor: SourceAnchor; row: HTMLElement };
type Changes = { runs: Change[]; capped: boolean };

function sourceAnchor(row: HTMLElement): SourceAnchor | null {
  for (const side of ["old", "new"] as const) {
    const operator = side === "old" ? "-" : "+";
    if (
      !row.querySelector(
        `.diff-line-content-operator[data-operator="${operator}"]`,
      )
    )
      continue;
    const number = row.querySelector(
      `[data-line-${side}-num], .diff-line-${side}-num [data-line-num]`,
    );
    const value =
      number?.getAttribute(`data-line-${side}-num`) ??
      number?.getAttribute("data-line-num");
    const line = value ? Number(value) : 0;
    if (Number.isSafeInteger(line) && line > 0) return { side, line };
  }
  return null;
}

/** The renderer's display indices join split sides and consecutive +/- rows.
 *  Source anchors keep the selected run stable across layout rebuilds. */
function readChanges(host: HTMLElement): Changes {
  const lines = new Map<
    number,
    { line: number; anchor: SourceAnchor | null; row: HTMLElement }
  >();
  const boundaries = new Set<number>();
  for (const row of host.querySelectorAll<HTMLElement>(
    "tr.diff-line[data-line][data-state]",
  )) {
    if (row.closest("[inert]")) continue;
    const index = row.dataset.line ?? "";
    if (row.dataset.state === "hunk") {
      const line = Number.parseInt(index, 10);
      if (Number.isFinite(line)) boundaries.add(line);
      continue;
    }
    if (row.dataset.state !== "diff" && row.dataset.state !== "plain") continue;
    const line = Number(index);
    if (!Number.isFinite(line)) continue;
    const anchor = sourceAnchor(row);
    const previous = lines.get(line);
    if (
      !previous ||
      (anchor &&
        (!previous.anchor ||
          (anchor.side === "old" && previous.anchor.side === "new")))
    )
      lines.set(line, { line, row, anchor });
  }
  const runs: Change[] = [];
  let previousLine: number | null = null;
  let previousChanged = false;
  for (const item of [...lines.values()].sort((a, b) => a.line - b.line)) {
    if (
      item.anchor &&
      (!previousChanged ||
        previousLine === null ||
        item.line !== previousLine + 1 ||
        boundaries.has(item.line))
    )
      runs.push({ line: item.line, anchor: item.anchor, row: item.row });
    previousLine = item.line;
    previousChanged = item.anchor !== null;
  }
  const capped = [...host.querySelectorAll("button")].some(
    (button) =>
      !button.closest("[inert]") &&
      button.textContent?.trim() === "Show full diff",
  );
  return { runs, capped };
}

function targetChange(
  runs: Change[],
  cursor: SourceAnchor | null,
  next: boolean,
) {
  const index =
    cursor === null
      ? -1
      : runs.findIndex(
          (run) =>
            run.anchor.side === cursor.side && run.anchor.line === cursor.line,
        );
  return runs[index + (next ? 1 : -1)];
}

/** Scrolls only the shown file slot; comment editors stay mounted. */
export function PrChangesNav({
  contentRef,
  disabled,
}: {
  contentRef: RefObject<HTMLDivElement | null>;
  disabled: boolean;
}) {
  const [changes, setChanges] = useState<Changes>({ runs: [], capped: false });
  const [cursor, setCursor] = useState<SourceAnchor | null>(null);
  useEffect(() => {
    const host = contentRef.current;
    if (!host) return;
    const update = () => {
      const next = readChanges(host);
      setChanges((previous) =>
        previous.capped === next.capped &&
        previous.runs.length === next.runs.length &&
        previous.runs.every(
          (run, index) =>
            run.line === next.runs[index].line &&
            run.anchor.side === next.runs[index].anchor.side &&
            run.anchor.line === next.runs[index].anchor.line &&
            run.row === next.runs[index].row,
        )
          ? previous
          : next,
      );
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(host, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "inert",
        "data-line",
        "data-state",
        "data-operator",
        "data-line-num",
        "data-line-old-num",
        "data-line-new-num",
      ],
    });
    return () => observer.disconnect();
  }, [contentRef]);

  const previous = targetChange(changes.runs, cursor, false);
  const next = targetChange(changes.runs, cursor, true);
  function navigate(forward: boolean) {
    const host = contentRef.current;
    if (disabled || !host || host.closest("[inert]")) return;
    const target = targetChange(readChanges(host).runs, cursor, forward);
    if (!target) return;
    useUiStore.getState().noteUserInteraction();
    setCursor(target.anchor);
    target.row.scrollIntoView({ block: "center", inline: "nearest" });
  }
  useHotkeyAction(
    "diff-previous-change",
    () => navigate(false),
    !disabled && previous !== undefined,
  );
  useHotkeyAction(
    "diff-next-change",
    () => navigate(true),
    !disabled && next !== undefined,
  );
  const wait = "Wait for the file to finish opening.";
  const nextReason = disabled
    ? wait
    : changes.capped
      ? "More changes are hidden. Choose Show full diff to navigate them."
      : "No next change.";

  return (
    <span
      role="group"
      aria-label="Change navigation"
      className="inline-flex shrink-0 items-center gap-0.5"
    >
      <DisabledReasonButton
        variant="ghost"
        size="icon-xs"
        aria-label="Previous change"
        title="Previous change"
        disabled={disabled || previous === undefined}
        reason={disabled ? wait : "No previous change."}
        onClick={() => navigate(false)}
      >
        <ArrowUpIcon aria-hidden />
      </DisabledReasonButton>
      <DisabledReasonButton
        variant="ghost"
        size="icon-xs"
        aria-label="Next change"
        title="Next change"
        disabled={disabled || next === undefined}
        reason={nextReason}
        onClick={() => navigate(true)}
      >
        <ArrowDownIcon aria-hidden />
      </DisabledReasonButton>
    </span>
  );
}
