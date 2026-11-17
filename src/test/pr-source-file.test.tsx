import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorState, EditorView } from "@uiw/react-codemirror";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiffPaneHold } from "@/features/diff/diff-pane-hold";
import { PrSourceFile } from "@/features/pulls/PrSourceFile";
import type { FileBytes } from "@/lib/git/api";
import { gitPrSnapshotFile } from "@/lib/git/api/pr-snapshot";
import { prSnapshotFileOptions } from "@/lib/git/queries/pr-snapshot";

vi.mock("@/lib/git/api/pr-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api/pr-snapshot")>()),
  gitPrSnapshotFile: vi.fn(),
}));

const REPO = "/repos/demo";
const HEAD = "abcdef0123".repeat(4);
const NEXT_HEAD = "123456789a".repeat(4);
const PATH = "src/unchanged.ts";
const readFile = vi.mocked(gitPrSnapshotFile);

function fileBytes(content: string | Uint8Array, mime: string | null = null) {
  const bytes =
    typeof content === "string"
      ? Buffer.from(content, "utf8")
      : Buffer.from(content);
  return {
    base64: bytes.toString("base64"),
    mime,
    tooLarge: false,
    size: bytes.length,
  } satisfies FileBytes;
}

let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  onlineManager.setOnline(true);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  readFile.mockResolvedValue(fileBytes("export const answer = 42;\n"));
});
afterEach(() => {
  client.clear();
  onlineManager.setOnline(true);
});

type Props = ComponentProps<typeof PrSourceFile>;

const sourceRegion = () => screen.getByRole("region", { name: /^Source of / });

async function expectSource(content: string) {
  await waitFor(() => expect(sourceRegion()).toHaveTextContent(content));
}

function mountSource(overrides: Partial<Props> = {}) {
  const reportRead = vi.fn();
  const props: Props = {
    repoPath: REPO,
    headSha: HEAD,
    path: PATH,
    reportRead,
    ...overrides,
  };
  const gates = new Map<symbol, boolean>();
  const hold = {
    interactive: true,
    phase: "shown" as const,
    reportSettled(settled: boolean) {
      const gate = Symbol();
      gates.set(gate, settled);
      return () => {
        gates.delete(gate);
      };
    },
  };
  const view = render(<PrSourceFile {...props} />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <DiffPaneHold value={hold}>{children}</DiffPaneHold>
      </QueryClientProvider>
    ),
  });
  return {
    ...view,
    props,
    reportRead,
    settled: () => gates.size > 0 && [...gates.values()].every(Boolean),
  };
}

describe("read-only MR source", () => {
  it("reads the exact MR head snapshot and settles after source arrives", async () => {
    let resolveRead!: (value: FileBytes) => void;
    readFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const view = mountSource({ lens: "upstream" });

    expect(screen.getByText(PATH)).toBeVisible();
    expect(screen.getByText("No MR changes")).toBeVisible();
    expect(view.settled()).toBe(false);
    expect(view.reportRead).toHaveBeenLastCalledWith({
      placeholder: false,
      loading: true,
    });
    expect(readFile).toHaveBeenCalledExactlyOnceWith(
      REPO,
      HEAD,
      PATH,
      "upstream",
    );

    await act(async () => {
      resolveRead(
        fileBytes('export const name = "<script>unsafe</script>";\n'),
      );
    });

    const source = screen.getByRole("region", { name: `Source of ${PATH}` });
    await waitFor(() => {
      expect(source).toHaveTextContent('export const name = "<script>');
      expect(view.settled()).toBe(true);
    });
    expect(source.querySelector(".hljs-keyword")).not.toBeNull();
    expect(source.querySelector("script")).toBeNull();
    expect(source.querySelector("textarea,[contenteditable=true]")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /comment|review|save/i }),
    ).toBeNull();
    expect(view.reportRead).toHaveBeenLastCalledWith({
      placeholder: false,
      loading: false,
    });
  });

  it("settles an uncached source offline and resumes the same lens on reconnect", async () => {
    onlineManager.setOnline(false);
    const view = mountSource({ lens: "upstream" });

    expect(
      screen.getByText(
        "You're offline — this file's source will load once you're back online.",
      ),
    ).toBeVisible();
    expect(view.reportRead).toHaveBeenLastCalledWith({
      placeholder: false,
      loading: false,
    });
    expect(view.settled()).toBe(true);
    expect(readFile).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();

    await act(async () => onlineManager.setOnline(true));
    await expectSource("export const answer");

    expect(readFile).toHaveBeenCalledExactlyOnceWith(
      REPO,
      HEAD,
      PATH,
      "upstream",
    );
    expect(view.settled()).toBe(true);
  });

  it("never shows another head's cached source while the next head is loading", async () => {
    const view = mountSource({ statusLabel: "MR changes unavailable" });
    await expectSource("export const answer");
    expect(screen.getByText("MR changes unavailable")).toBeVisible();
    let resolveRead!: (value: FileBytes) => void;
    readFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );

    view.rerender(<PrSourceFile {...view.props} headSha={NEXT_HEAD} />);

    expect(sourceRegion()).not.toHaveTextContent("export const answer");
    expect(view.settled()).toBe(false);
    expect(readFile).toHaveBeenLastCalledWith(REPO, NEXT_HEAD, PATH, "origin");
    await act(async () => {
      resolveRead(fileBytes("export const next = true;\n"));
    });
    await expectSource("export const next");
    expect(view.settled()).toBe(true);
  });

  it.each(["", "HEAD"])(
    "refuses the non-commit head %j without reading the working tree",
    (headSha) => {
      const view = mountSource({ headSha });

      expect(screen.getByText("MR head commit is unavailable.")).toBeVisible();
      expect(readFile).not.toHaveBeenCalled();
      expect(view.settled()).toBe(true);
      expect(view.reportRead).toHaveBeenLastCalledWith({
        placeholder: false,
        loading: false,
      });
    },
  );

  it.each([
    { data: fileBytes(""), message: "Empty file" },
    { data: null, message: "File not present at this MR head." },
  ])(
    "settles a terminal empty or missing source: $message",
    async ({ data, message }) => {
      readFile.mockResolvedValueOnce(data);
      const view = mountSource();

      expect(await screen.findByText(message)).toBeVisible();
      expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
      expect(view.settled()).toBe(true);
    },
  );

  it.each([new Uint8Array([65, 0, 66]), new Uint8Array([0xff, 0xfe, 0x41])])(
    "treats NUL or invalid UTF-8 bytes as binary despite a null MIME",
    async (bytes) => {
      readFile.mockResolvedValueOnce(fileBytes(bytes));
      const view = mountSource();

      expect(
        await screen.findByText("Binary file — source preview unavailable."),
      ).toBeVisible();
      expect(screen.queryByRole("img")).toBeNull();
      expect(view.settled()).toBe(true);
    },
  );

  it("settles an oversized refusal without decoding its withheld bytes", async () => {
    readFile.mockResolvedValueOnce({
      base64: null,
      mime: "image/png",
      tooLarge: true,
      size: 20_000_001,
    });
    const view = mountSource();

    expect(await screen.findByText("File too large to preview")).toBeVisible();
    expect(screen.queryByRole("img")).toBeNull();
    expect(view.settled()).toBe(true);
  });

  it("previews only a vetted raster MIME and waits for image decode before settling", async () => {
    const data = fileBytes(new Uint8Array([137, 80, 78, 71]), "image/png");
    readFile.mockResolvedValueOnce(data);
    const view = mountSource({ path: "assets/image.unknown" });

    const image = await screen.findByRole("img", {
      name: "assets/image.unknown at MR head",
    });
    expect(image).toHaveAttribute(
      "src",
      `data:image/png;base64,${data.base64}`,
    );
    expect(view.settled()).toBe(false);

    fireEvent.load(image);

    expect(view.settled()).toBe(true);
  });

  it("settles a failed image decode with an explicit refusal", async () => {
    readFile.mockResolvedValueOnce(
      fileBytes(new Uint8Array([137, 80, 78, 71]), "image/png"),
    );
    const view = mountSource();
    const image = await screen.findByRole("img");

    fireEvent.error(image);

    expect(
      await screen.findByText("Image could not be previewed."),
    ).toBeVisible();
    expect(view.settled()).toBe(true);
  });

  it("renders SVG and HTML as escaped source rather than active documents", async () => {
    readFile.mockResolvedValueOnce(
      fileBytes(
        '<svg onload="alert(1)"><script>alert(1)</script></svg>',
        "image/svg+xml",
      ),
    );
    const view = mountSource({ path: "assets/vector.svg" });
    const source = screen.getByRole("region", {
      name: "Source of assets/vector.svg",
    });

    await waitFor(() =>
      expect(source).toHaveTextContent('<svg onload="alert(1)">'),
    );

    expect(
      source.querySelector("img,script,iframe,object,svg[onload]"),
    ).toBeNull();
    expect(view.settled()).toBe(true);
  });

  it("uses a read-only virtualized plain editor for large source", async () => {
    const content = "const line = 'read me';\n".repeat(12_000);
    readFile.mockResolvedValueOnce(fileBytes(content));
    const view = mountSource();
    const editor = await screen.findByRole("textbox", {
      name: `Source of ${PATH}`,
    });

    expect(editor).toHaveAttribute("contenteditable", "false");
    expect(editor).toHaveAttribute("tabindex", "0");
    const cm = EditorView.findFromDOM(editor);
    expect(cm?.state.facet(EditorState.readOnly)).toBe(true);
    expect(editor.querySelectorAll(".cm-line").length).toBeLessThan(500);
    expect(editor.querySelector(".hljs-keyword")).toBeNull();
    expect(view.settled()).toBe(true);
  });

  it("offers Retry for a failed read and rescues focus when the retry starts", async () => {
    const user = userEvent.setup();
    readFile.mockRejectedValue(new Error("object unavailable"));
    const view = mountSource();
    const retry = await screen.findByRole("button", {
      name: "Retry loading file source",
    });
    expect(view.settled()).toBe(true);
    let resolveRead!: (value: FileBytes) => void;
    readFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );

    await user.click(retry);
    await waitFor(() => expect(view.settled()).toBe(false));

    expect(
      screen.getByRole("region", { name: `Source of ${PATH}` }),
    ).toHaveFocus();
    await act(async () => {
      resolveRead(fileBytes("export const recovered = true;\n"));
    });
    await expectSource("export const recovered");
    expect(view.settled()).toBe(true);
  });

  it("keeps the last exact-head source visible when a refresh fails", async () => {
    mountSource();
    await expectSource("export const answer");
    readFile.mockRejectedValue(new Error("object unavailable"));

    await act(async () => {
      await client.refetchQueries({
        queryKey: prSnapshotFileOptions(REPO, HEAD, PATH, "origin").queryKey,
        exact: true,
      });
    });

    expect(sourceRegion()).toHaveTextContent("export const answer");
    expect(
      await screen.findByText(
        "Couldn't refresh this file source — showing the last loaded version.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Retry loading file source" }),
    ).toBeVisible();
  });
});
