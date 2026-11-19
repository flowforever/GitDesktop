/** Literal, case-insensitive by default; match offsets stay in the original text. */
export function literalSearchPattern(
  query: string,
  matchCase = false,
): RegExp | null {
  return query === ""
    ? null
    : new RegExp(
        query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        matchCase ? "gu" : "giu",
      );
}

export interface DiffTextMatch {
  range: Range;
  cell: HTMLElement;
}

const BLOCKED =
  '[inert],[hidden],[aria-hidden="true"],[data-diff-line-widget],.diff-line-widget';
const MAX_MATCHES = 10_000;

/** Read code only, leaving syntax spans, comment widgets and selection intact. */
export function findDiffText(
  host: HTMLElement,
  query: string,
  matchCase: boolean,
) {
  const pattern = literalSearchPattern(query, matchCase);
  const matches: DiffTextMatch[] = [];
  if (!pattern || host.closest(BLOCKED)) return { matches, capped: false };
  const columns = host.closest(".gd-diff-columns");
  for (const code of host.querySelectorAll<HTMLElement>(
    ".diff-line-content-raw, .diff-line-syntax-raw",
  )) {
    if (code.closest(BLOCKED)) continue;
    if (columns && code.closest(".gd-diff-columns") !== columns) continue;
    const nodes: { node: Text; start: number; end: number }[] = [];
    let text = "";
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (
        node.parentElement?.closest("[data-no-newline-at-end-of-file-symbol]")
      )
        continue;
      const value = node.textContent ?? "";
      nodes.push({
        node: node as Text,
        start: text.length,
        end: text.length + value.length,
      });
      text += value;
    }
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      if (matches.length === MAX_MATCHES) return { matches, capped: true };
      const from = match.index;
      const to = from + match[0].length;
      const start = nodes.find((node) => node.start <= from && node.end > from);
      const end = nodes.find((node) => node.start < to && node.end >= to);
      if (!start || !end) continue;
      const range = document.createRange();
      range.setStart(start.node, from - start.start);
      range.setEnd(end.node, to - end.start);
      matches.push({ range, cell: code.closest<HTMLElement>("td") ?? code });
    }
  }
  return { matches, capped: false };
}

const owners = new Map<string, { matches: DiffTextMatch[]; active: number }>();

function paintHighlights() {
  if (
    typeof CSS === "undefined" ||
    !CSS.highlights ||
    typeof Highlight === "undefined"
  )
    return;
  if (owners.size === 0) {
    CSS.highlights.delete("gd-diff-find");
    CSS.highlights.delete("gd-diff-find-current");
    return;
  }
  const all = new Highlight();
  const current = new Highlight();
  for (const value of owners.values()) {
    for (const match of value.matches) all.add(match.range);
    const active = value.matches[value.active];
    if (active) current.add(active.range);
  }
  current.priority = 1;
  CSS.highlights.set("gd-diff-find", all);
  CSS.highlights.set("gd-diff-find-current", current);
}

export function highlightDiffMatches(
  owner: string,
  matches: DiffTextMatch[],
  active: number,
) {
  owners.set(owner, { matches, active });
  paintHighlights();
  const cell = matches[active]?.cell;
  cell?.classList.add("gd-diff-find-current");
  return () => {
    cell?.classList.remove("gd-diff-find-current");
    owners.delete(owner);
    paintHighlights();
  };
}
