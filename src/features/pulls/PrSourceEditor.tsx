import CodeMirror, { Decoration, EditorView } from "@uiw/react-codemirror";
import { useMemo } from "react";
import { PR_CODE_IMPORT_MAX_CHARS, scanPrCodeImports } from "./pr-code-imports";

/** The large-file editor stays off the ordinary highlighted-source path. */
export default function PrSourceEditor({
  path,
  text,
  importLinks,
  isDark,
  onReady,
}: {
  path: string;
  text: string;
  importLinks: boolean;
  isDark: boolean;
  onReady: () => void;
}) {
  const extensions = useMemo(
    () =>
      !importLinks ||
      !/\.[cm]?[jt]sx?$/i.test(path) ||
      text.length > PR_CODE_IMPORT_MAX_CHARS
        ? []
        : [
            EditorView.decorations.of(
              Decoration.set(
                scanPrCodeImports(text, /\.[jt]sx$/i.test(path)).map((item) =>
                  Decoration.mark({
                    tagName: "a",
                    attributes: {
                      href: "#mr-import",
                      "data-pr-code-import": item.specifier,
                      "data-pr-code-source": path,
                      "aria-label": item.specifier,
                      title: "Open import at MR head",
                      draggable: "false",
                      tabindex: "0",
                      class:
                        "cursor-pointer hover:underline underline-offset-2 focus-visible:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
                    },
                  }).range(item.from, item.to),
                ),
              ),
            ),
          ],
    [path, text, importLinks],
  );
  return (
    <CodeMirror
      value={text}
      readOnly
      editable={false}
      indentWithTab={false}
      theme={isDark ? "dark" : "light"}
      height="100%"
      extensions={extensions}
      basicSetup={{
        foldGutter: false,
        highlightActiveLine: false,
        highlightActiveLineGutter: false,
        autocompletion: false,
        bracketMatching: false,
        closeBrackets: false,
        syntaxHighlighting: false,
      }}
      onCreateEditor={(view) => {
        view.contentDOM.tabIndex = 0;
        view.contentDOM.setAttribute("aria-label", `Source of ${path}`);
        view.contentDOM.setAttribute("aria-readonly", "true");
        onReady();
      }}
      className="h-full overflow-hidden text-xs [&_.cm-editor]:h-full [&_.cm-focused]:outline-none"
    />
  );
}
