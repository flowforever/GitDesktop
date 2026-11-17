import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useState,
} from "react";
import { create } from "zustand";
import { documentId, type MrDocument } from "@/lib/stores/work-documents";
import { useKeyedEntityState } from "@/lib/use-keyed-entity-state";

const useMrDraftStore = create<{ entries: Record<string, string> }>(() => ({
  entries: {},
}));
const MrDraftScope = createContext<string | null>(null);

export function MrDocumentDraftScope({
  id,
  children,
}: {
  id: string | null;
  children: ReactNode;
}) {
  return createElement(MrDraftScope.Provider, { value: id }, children);
}

export function useMrScopedDraft(field: string) {
  const scope = useContext(MrDraftScope);
  const local = useState("");
  const session = useMrTextDraft(`${scope ?? "unscoped"}|${field}`);
  return [
    scope ? session.value : local[0],
    scope ? session.set : local[1],
    scope !== null,
  ] as const;
}

export function useMrScopedKeyedDraft(entityKey: string) {
  const scope = useContext(MrDraftScope);
  const local = useKeyedEntityState(entityKey, "");
  const key = (captured: string) => `${scope}|${captured}`;
  const session = useMrTextDraft(key(entityKey));
  return scope
    ? {
        ...session,
        setFor: (captured: string, update: (previous: string) => string) =>
          session.setFor(key(captured), update),
        clearFor: (captured: string) => session.clearFor(key(captured)),
      }
    : local;
}

export function hasMrTextDraft(doc: MrDocument): boolean {
  return Object.entries(useMrDraftStore.getState().entries).some(
    ([key, text]) =>
      key.startsWith(`${documentId(doc)}|`) && text.trim().length > 0,
  );
}

export function useMrTextDraft(entityKey: string) {
  const value = useMrDraftStore((s) => s.entries[entityKey] ?? "");
  const setFor = useCallback(
    (key: string, updater: (previous: string) => string) =>
      useMrDraftStore.setState((s) => {
        const next = updater(s.entries[key] ?? "");
        const entries = { ...s.entries };
        if (next === "") delete entries[key];
        else entries[key] = next;
        return { entries };
      }),
    [],
  );
  const set = useCallback(
    (next: string | ((previous: string) => string)) =>
      setFor(entityKey, (previous) =>
        typeof next === "function" ? next(previous) : next,
      ),
    [entityKey, setFor],
  );
  return {
    value,
    set,
    setFor,
    clearFor: (key: string) => setFor(key, () => ""),
  };
}

export function useMrCommentDraft(entityKey: string) {
  const scope = useContext(MrDraftScope);
  const local = useKeyedEntityState(entityKey, "");
  const key = `${scope}|comment`;
  const session = useMrTextDraft(key);
  const translate = (captured: string) =>
    captured === entityKey ? key : `${scope}|comment|${captured}`;
  return scope
    ? {
        ...session,
        setFor: (captured: string, update: (previous: string) => string) =>
          session.setFor(translate(captured), update),
        clearFor: (captured: string) => session.clearFor(translate(captured)),
      }
    : local;
}
