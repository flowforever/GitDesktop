import { literalSearchPattern } from "../diff/text-search.ts";

export interface PrDiffSearchMatch {
  path: string;
  side: "old" | "new";
  line: number;
  column: number;
  text: string;
}

/** Search patch content without counting headers, or duplicating context lines. */
export function searchPrDiffs(
  sections: ReadonlyMap<string, string>,
  query: string,
  matchCase = false,
) {
  const pattern = literalSearchPattern(query, matchCase);
  const matches: PrDiffSearchMatch[] = [];
  const paths = new Set<string>();
  let total = 0;
  if (!pattern) return { matches, total, files: 0 };
  for (const [path, patch] of sections) {
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;
    for (const raw of patch.split("\n")) {
      const line = raw.replace(/\r$/, "");
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        inHunk = true;
        continue;
      }
      if (!inHunk || !/^[ +-]/.test(line)) continue;
      const prefix = line[0];
      const text = line.slice(1);
      const side = prefix === "-" ? "old" : "new";
      const number = side === "old" ? oldLine : newLine;
      pattern.lastIndex = 0;
      const found = pattern.exec(text);
      if (found && number > 0) {
        total++;
        paths.add(path);
        // Count every matching line; bound only the rendered result list.
        if (matches.length < 500) {
          const from = Math.max(0, found.index - 60);
          const to = Math.min(
            text.length,
            Math.max(from + 220, found.index + found[0].length),
          );
          matches.push({
            path,
            side,
            line: number,
            column: found.index + 1,
            text: `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`,
          });
        }
      }
      if (prefix !== "+") oldLine++;
      if (prefix !== "-") newLine++;
    }
  }
  return { matches, total, files: paths.size };
}
