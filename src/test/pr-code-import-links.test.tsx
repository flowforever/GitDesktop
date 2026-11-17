import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DiffContent } from "@/features/diff/DiffSurface";
import { DiffPaneHold } from "@/features/diff/diff-pane-hold";
import { HighlightedCode } from "@/features/diff/HighlightedCode";
import { PrCodeImportLinks } from "@/features/pulls/PrCodeImportLinks";
import { scanPrCodeImports } from "@/features/pulls/pr-code-imports";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { stubCanvas } from "./canvas-stub";

const PATH = "src/new/main.ts";
const OLD_PATH = "src/old/main.ts";
const clients: QueryClient[] = [];
beforeAll(stubCanvas);
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  if (vi.isMockFunction(window.getSelection))
    vi.mocked(window.getSelection).mockRestore();
  if (vi.isMockFunction(HTMLElement.prototype.getBoundingClientRect))
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockRestore();
});

describe("MR code import scanner", () => {
  it.each([
    ['const node = <p>import value from "./example";</p>;', []],
    [
      'const node = <><p>import value from "./text";</p><span>require("./sibling")</span></>;',
      [],
    ],
    ["const node = <Box title=\"import value from './attribute'\" />;", []],
    [
      `const node = <Box
 title="require('./attribute')"
>
 export * from "./text";
 <Child>import value from "./nested";</Child>
</Box>;`,
      [],
    ],
    [
      'const node = <p>{/* import value from "./comment" */}{import("./actual")}</p>;',
      ["./actual"],
    ],
    [
      'const node = <Box value={require("./attribute-expression")} />;',
      ["./attribute-expression"],
    ],
    [
      'const node = <p>{condition ? <span>import value from "./nested-text";</span> : import("./actual")}</p>;',
      ["./actual"],
    ],
    ['const node = <p>{require}{("./separate-expression")}</p>;', []],
    ['const loader = <T,>(value: T) => import("./generic");', ["./generic"]],
    [
      'const loader = <T extends Foo>(value: T) => require("./constrained");',
      ["./constrained"],
    ],
    [
      'const view = <T extends Foo>(value: T) => <p>{import("./generic-jsx")}</p>;',
      ["./generic-jsx"],
    ],
  ])("keeps JSX text separate from JavaScript in %s", (source, expected) => {
    const imports = scanPrCodeImports(source, true);
    expect(imports.map((item) => item.specifier)).toEqual(expected);
    for (const item of imports)
      expect(source.slice(item.from, item.to)).toBe(item.specifier);
  });

  it.each([
    ['import value from "./value";', ["./value"]],
    ["import './setup';", ["./setup"]],
    ['import type { Value } from "@/value";', ["@/value"]],
    [
      'import {\n  type Value,\n  helper as renamed,\n} /* note */ from\n "./context";',
      ["./context"],
    ],
    [
      'export {\n Value,\n} from "../shared"; export * as ns from "@pkg/name";',
      ["../shared", "@pkg/name"],
    ],
    ['export type { Value } from "./types";', ["./types"]],
    [
      'const x = import( /* note */ "./lazy"); const y = require("./common");',
      ["./lazy", "./common"],
    ],
    [
      '// import fake from "./comment"\n/* require("./block") */\nimport real from "./real";',
      ["./real"],
    ],
    [
      'const text = "import fake from \'./string\'"; const from = "./value";',
      [],
    ],
    [
      'const text = `import fake from "./template"`; import(`./dynamic-template`);',
      [],
    ],
    ['const text = `outer ${`import("./nested")`} tail`;', []],
    [
      'const pattern = /import\\(".\\/regex"\\)/; import real from "./real";',
      ["./real"],
    ],
    [
      'object.require("./method"); object.import("./method"); export const from = "./normal";',
      [],
    ],
  ])("finds only import specifiers in %s", (source, expected) => {
    const imports = scanPrCodeImports(source);
    expect(imports.map((item) => item.specifier)).toEqual(expected);
    for (const item of imports)
      expect(source.slice(item.from, item.to)).toBe(item.specifier);
  });
});

function renderDiff({
  onOpen = vi.fn(),
  oldPath,
  getSource,
  patch = '@@ -1 +1 @@\n-import oldValue from "./before";\n+import newValue from "./after";\n',
}: {
  onOpen?: (specifier: string, sourcePath: string) => void;
  oldPath?: string;
  getSource?: (
    side: "old" | "new",
  ) => Promise<{ path: string; text: string } | null>;
  patch?: string;
} = {}) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 800,
    right: 1200,
    width: 1200,
    height: 800,
    toJSON: () => ({}),
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  client.setQueryData(settingsKeys.settings, {
    ...DEFAULT_SETTINGS,
    diffViewMode: "split",
  });
  return render(
    <QueryClientProvider client={client}>
      <PrCodeImportLinks
        path={PATH}
        oldPath={oldPath}
        onOpen={onOpen}
        getSource={getSource}
      >
        <DiffContent
          filePath={PATH}
          data={{
            filePath: PATH,
            text: `diff --git a/${PATH} b/${PATH}\n--- a/${PATH}\n+++ b/${PATH}\n${patch}`,
            isBinary: false,
            isTruncated: false,
          }}
          isPending={false}
          isError={false}
        />
      </PrCodeImportLinks>
    </QueryClientProvider>,
  );
}

describe("MR import links in actual code surfaces", () => {
  it.each([
    ["src/main.py", "from .helper import Thing\n", ".helper", undefined],
    ["src/lib.rs", "use crate::model;\n", "crate::model", "rust-use"],
    ["lib/main.dart", "import 'helper.dart';\n", "helper.dart", undefined],
  ] as const)(
    "follows a native import in %s without changing source text",
    async (path, source, specifier, kind) => {
      const onOpen = vi.fn();
      const { container } = render(
        <PrCodeImportLinks path={path} onOpen={onOpen}>
          <HighlightedCode path={path} content={source} htmlFallback />
        </PrCodeImportLinks>,
      );
      const link = await screen.findByRole("link", { name: specifier });
      expect(container.querySelector("pre")).toHaveTextContent(source.trim());
      await userEvent.click(link);
      if (kind)
        expect(onOpen).toHaveBeenCalledExactlyOnceWith(specifier, path, kind);
      else expect(onOpen).toHaveBeenCalledExactlyOnceWith(specifier, path);
    },
  );

  it("escapes plain source markup before decorating imports", async () => {
    const source =
      'import "helper.dart";\nconst html = "<img src=x onerror=alert(1)> & <script>bad()</script>";';
    const { container } = render(
      <PrCodeImportLinks path="main.dart" onOpen={vi.fn()}>
        <HighlightedCode path="main.dart" content={source} htmlFallback />
      </PrCodeImportLinks>,
    );
    await screen.findByRole("link", { name: "helper.dart" });
    expect(container.querySelector("pre")?.textContent).toBe(source);
    expect(container.querySelector("img,script")).toBeNull();
  });

  it("uses JSX grammar for preview islands while keeping real expression imports clickable", async () => {
    const source =
      'const node = <p>import value from "./example";</p>; const loader = import("./actual");';
    const onOpen = vi.fn();
    render(
      <PrCodeImportLinks path="src/view.tsx" onOpen={onOpen}>
        <pre
          className="gd-code"
          dangerouslySetInnerHTML={{
            __html: source.replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
          }}
        />
      </PrCodeImportLinks>,
    );
    await userEvent.click(
      await screen.findByRole("link", { name: "./actual" }),
    );
    expect(screen.queryByRole("link", { name: "./example" })).toBeNull();
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("./actual", "src/view.tsx");
    expect(document.querySelector("pre.gd-code")?.textContent).toBe(source);
  });

  it("links real highlighted imports without changing text, syntax spans, or ordinary strings", async () => {
    const source =
      'import { value } from "./context";\nconst ordinary = "./not-an-import";\n// import fake from "./comment";\n';
    const onOpen = vi.fn();
    render(
      <PrCodeImportLinks path={PATH} onOpen={onOpen}>
        <HighlightedCode path={PATH} content={source} />
      </PrCodeImportLinks>,
    );
    const link = await screen.findByRole("link", { name: "./context" });

    expect(link).toHaveAttribute("href", "#mr-import");
    expect(document.querySelector("pre.gd-code")?.textContent).toBe(source);
    expect(document.querySelector(".hljs-keyword")).not.toBeNull();
    expect(screen.queryByRole("link", { name: "./not-an-import" })).toBeNull();
    expect(screen.queryByRole("link", { name: "./comment" })).toBeNull();
    await userEvent.click(link);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("./context", PATH);
    link.focus();
    await userEvent.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("preserves split syntax and word-diff spans inside a single import string", async () => {
    const markup =
      'import value from <span class="hljs-string">"./<span class="diff-changed">con</span>text"</span>;';
    render(
      <PrCodeImportLinks path={PATH} onOpen={vi.fn()}>
        <span className="diff-line-syntax-raw">
          <span data-template dangerouslySetInnerHTML={{ __html: markup }} />
        </span>
      </PrCodeImportLinks>,
    );
    const link = await screen.findByRole("link", { name: "./context" });
    expect(link.querySelector(".diff-changed")).toHaveTextContent("con");
    expect(
      link.closest(".hljs-string") ?? link.querySelector(".hljs-string"),
    ).not.toBeNull();
    expect(link.parentElement?.textContent).toContain('"./context"');
  });

  it("recognizes multiline imports across real diff rows and uses the source path of each side", async () => {
    const onOpen = vi.fn();
    renderDiff({
      oldPath: OLD_PATH,
      onOpen,
      patch:
        '@@ -1,3 +1,3 @@\n import {\n-  oldValue,\n+  newValue,\n-} from "./before";\n+} from "./after";\n',
    });
    await userEvent.click(
      await screen.findByRole("link", { name: "./before" }),
    );
    await userEvent.click(await screen.findByRole("link", { name: "./after" }));

    expect(onOpen.mock.calls).toEqual([
      ["./before", OLD_PATH],
      ["./after", PATH],
    ]);
  });

  it("does not guess an old-side path when rename provenance is absent", async () => {
    renderDiff();
    expect(await screen.findByRole("link", { name: "./after" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "./before" })).toBeNull();
  });

  it("validates partial hunks against complete source before linking an unstarred block-comment line", async () => {
    const prefix = `/* opened outside the hunk\n${"filler\n".repeat(38)}`;
    const getSource = vi.fn(async (side: "old" | "new") => ({
      path: side === "old" ? OLD_PATH : PATH,
      text: `${prefix}import fake from "./comment";\n*/\nimport value from "./${side === "old" ? "before" : "after"}";\n`,
    }));
    renderDiff({
      getSource,
      patch:
        '@@ -40,3 +40,3 @@\n import fake from "./comment";\n */\n-import value from "./before";\n+import value from "./after";\n',
    });

    expect(await screen.findByRole("link", { name: "./after" })).toBeVisible();
    expect(await screen.findByRole("link", { name: "./before" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "./comment" })).toBeNull();
    expect(getSource).toHaveBeenCalledTimes(2);
  });

  it("ignores stale source proof after the wrapper becomes disabled", async () => {
    let resolveSource!: (value: { path: string; text: string } | null) => void;
    const getSource = vi.fn(
      () =>
        new Promise<{ path: string; text: string } | null>((resolve) => {
          resolveSource = resolve;
        }),
    );
    const onOpen = vi.fn();
    const markup =
      'import value from <span class="hljs-string">"./context"</span>;';
    const children = (
      <table>
        <tbody>
          <tr className="diff-line" data-line="0" data-state="diff">
            <td className="diff-line-new-num">
              <span data-line-num="40">40</span>
            </td>
            <td className="diff-line-new-content">
              <span className="diff-line-syntax-raw">
                <span
                  data-template
                  dangerouslySetInnerHTML={{ __html: markup }}
                />
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    );
    const view = render(
      <PrCodeImportLinks path={PATH} onOpen={onOpen} getSource={getSource}>
        {children}
      </PrCodeImportLinks>,
    );
    await waitFor(() => expect(getSource).toHaveBeenCalledOnce());
    view.rerender(
      <PrCodeImportLinks
        path={PATH}
        onOpen={onOpen}
        getSource={getSource}
        disabled
      >
        {children}
      </PrCodeImportLinks>,
    );
    await act(async () =>
      resolveSource({
        path: PATH,
        text: `${"\n".repeat(39)}import value from "./context";\n`,
      }),
    );

    expect(screen.queryByRole("link", { name: "./context" })).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("blocks diff mousedown selection and keeps an existing drag selection from opening a link", async () => {
    const onOpen = vi.fn();
    const onMouseDown = vi.fn();
    render(
      <div onMouseDown={onMouseDown}>
        <PrCodeImportLinks path={PATH} onOpen={onOpen}>
          <HighlightedCode
            path={PATH}
            content={'import value from "./context";'}
          />
        </PrCodeImportLinks>
      </div>,
    );
    const link = await screen.findByRole("link", { name: "./context" });
    fireEvent.mouseDown(link);
    expect(onMouseDown).not.toHaveBeenCalled();
    const selection = document.getSelection();
    selection?.selectAllChildren(link);
    fireEvent.click(link);

    expect(onOpen).not.toHaveBeenCalled();
    selection?.removeAllRanges();
  });

  it("honors disabled, held, and live inert guards for delegated CodeMirror links", () => {
    const onOpen = vi.fn();
    const child = (
      <a
        href="#mr-import"
        data-pr-code-import="./context"
        data-pr-code-source={PATH}
      >
        ./context
      </a>
    );
    const view = render(
      <PrCodeImportLinks path={PATH} onOpen={onOpen}>
        {child}
      </PrCodeImportLinks>,
    );
    const link = screen.getByRole("link", { name: "./context" });
    view.rerender(
      <PrCodeImportLinks path={PATH} onOpen={onOpen} disabled>
        {child}
      </PrCodeImportLinks>,
    );
    fireEvent.click(link);
    view.rerender(
      <DiffPaneHold
        value={{
          interactive: false,
          phase: "held",
          reportSettled: () => () => undefined,
        }}
      >
        <PrCodeImportLinks path={PATH} onOpen={onOpen}>
          {child}
        </PrCodeImportLinks>
      </DiffPaneHold>,
    );
    fireEvent.click(screen.getByRole("link", { name: "./context" }));
    view.rerender(
      <PrCodeImportLinks path={PATH} onOpen={onOpen}>
        {child}
      </PrCodeImportLinks>,
    );
    const current = screen.getByRole("link", { name: "./context" });
    current.setAttribute("inert", "");
    fireEvent.click(current);

    expect(onOpen).not.toHaveBeenCalled();
  });

  it("redecorates replaced highlight islands once while leaving React-owned code and widgets alone", async () => {
    const onOpen = vi.fn();
    const view = render(
      <PrCodeImportLinks path={PATH} onOpen={onOpen}>
        <HighlightedCode path={PATH} content={'import one from "./one";'} />
      </PrCodeImportLinks>,
    );
    await screen.findByRole("link", { name: "./one" });
    view.rerender(
      <PrCodeImportLinks path={PATH} onOpen={onOpen}>
        <HighlightedCode path={PATH} content={'import two from "./two";'} />
        <pre>{'import plain from "./react-owned";'}</pre>
        <div data-diff-line-widget="layout">
          <HighlightedCode
            path={PATH}
            content={'import widget from "./widget";'}
          />
        </div>
      </PrCodeImportLinks>,
    );

    expect(await screen.findByRole("link", { name: "./two" })).toBeVisible();
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "./one" })).toBeNull();
    expect(document.querySelector("pre.gd-code")?.textContent).toBe(
      'import two from "./two";',
    );
  });
});
