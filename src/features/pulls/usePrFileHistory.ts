import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

export type PrFileVisit = Readonly<{
  path: string;
  kind: "change" | "source";
  allFiles: boolean;
}>;

type HistoryState = {
  identity: string;
  selectedPath: string | null;
  visits: readonly PrFileVisit[];
  cursor: number;
};

export type PrFileHistory = {
  current: PrFileVisit | null;
  previous: PrFileVisit | null;
  next: PrFileVisit | null;
  visit: (next: PrFileVisit) => void;
  back: () => PrFileVisit | null;
  forward: () => PrFileVisit | null;
};

function initialHistory(identity: string, path: string | null): HistoryState {
  return {
    identity,
    selectedPath: path,
    visits: path ? [{ path, kind: "change", allFiles: false }] : [],
    cursor: path ? 0 : -1,
  };
}

function visit(state: HistoryState, next: PrFileVisit): HistoryState {
  if (!next.path) return state;
  const current = state.visits[state.cursor];
  const location = {
    ...next,
    allFiles: next.allFiles || next.kind === "source",
  };
  if (current?.path === location.path) {
    if (
      current.kind === location.kind &&
      current.allFiles === location.allFiles
    )
      return state;
    const visits = [...state.visits];
    visits[state.cursor] = location;
    return { ...state, visits };
  }
  const visits = [...state.visits.slice(0, state.cursor + 1), location];
  return { ...state, visits, cursor: visits.length - 1 };
}

/** The parent owns history while Files unmounts. Entries follow selection intent,
 *  never the deferred renderer; a controlled changed-path update acknowledges it. */
export function usePrFileHistory(
  identity: string,
  selectedPath: string | null,
  enabled = true,
): PrFileHistory {
  const [stored, setStored] = useState(() =>
    initialHistory(identity, enabled ? selectedPath : null),
  );
  let state = stored;
  if (state.identity !== identity)
    state = initialHistory(identity, enabled ? selectedPath : null);
  else if (enabled && selectedPath && selectedPath !== state.selectedPath) {
    const acknowledged = { ...state, selectedPath };
    const current = state.visits[state.cursor];
    state =
      current?.kind === "change" && current.path === selectedPath
        ? acknowledged
        : visit(acknowledged, {
            path: selectedPath,
            kind: "change",
            allFiles: current?.allFiles ?? false,
          });
  }
  if (state !== stored) setStored(state);

  const live = useRef<{ state: HistoryState; enabled: boolean } | null>(null);
  useLayoutEffect(() => {
    live.current = { state, enabled };
  });
  useLayoutEffect(
    () => () => {
      live.current = null;
    },
    [],
  );

  const apply = useCallback(
    (change: (value: HistoryState) => HistoryState) => {
      const current = live.current;
      if (!current?.enabled || current.state.identity !== identity) return null;
      const next = change(current.state);
      if (next === current.state) return null;
      // Multiple activations before a paint continue from the latest cursor.
      live.current = { ...current, state: next };
      setStored(next);
      return next.visits[next.cursor] ?? null;
    },
    [identity],
  );
  const record = useCallback(
    (next: PrFileVisit) => {
      apply((value) => visit(value, next));
    },
    [apply],
  );
  const back = useCallback(
    () =>
      apply((value) =>
        value.cursor > 0 ? { ...value, cursor: value.cursor - 1 } : value,
      ),
    [apply],
  );
  const forward = useCallback(
    () =>
      apply((value) =>
        value.cursor < value.visits.length - 1
          ? { ...value, cursor: value.cursor + 1 }
          : value,
      ),
    [apply],
  );
  return useMemo(
    () => ({
      current: state.visits[state.cursor] ?? null,
      previous: state.visits[state.cursor - 1] ?? null,
      next: state.visits[state.cursor + 1] ?? null,
      visit: record,
      back,
      forward,
    }),
    [state, record, back, forward],
  );
}
