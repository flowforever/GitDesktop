import { useSyncExternalStore } from "react";
import { lineComposerOpen } from "./whitespace-mode";

export function subscribeLineComposer(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-diff-line-widget"],
  });
  return () => observer.disconnect();
}

/** The open editor lives in a renderer-owned DOM widget, outside React props. */
export function useLineComposerOpen(): boolean {
  return useSyncExternalStore(subscribeLineComposer, lineComposerOpen);
}
