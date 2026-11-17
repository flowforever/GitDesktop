import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DiffContent } from "@/features/diff/DiffSurface";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { stubCanvas } from "./canvas-stub";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

const PATH = "complete.txt";
const rows = Array.from({ length: 350 }, (_, index) => ` context-${index + 1}`);
rows[174] = "-before-change\n+after-change";
const PATCH = `diff --git a/${PATH} b/${PATH}\n--- a/${PATH}\n+++ b/${PATH}\n@@ -1,350 +1,350 @@\n${rows.join("\n")}\n`;

let client: QueryClient;
beforeAll(stubCanvas);
beforeEach(() => {
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => client.clear());

function mount(fullContext: boolean, mode: "split" | "unified") {
  client.setQueryData(settingsKeys.settings, {
    ...DEFAULT_SETTINGS,
    diffViewMode: mode,
  });
  render(
    <QueryClientProvider client={client}>
      <DiffContent
        filePath={PATH}
        data={{
          filePath: PATH,
          text: PATCH,
          isBinary: false,
          isTruncated: false,
        }}
        isPending={false}
        isError={false}
        fullContext={fullContext}
      />
    </QueryClientProvider>,
  );
}

describe("verified full-context comparison", () => {
  it.each(["unified", "split"] as const)(
    "shows both complete sides beyond the normal cap in %s mode",
    async (mode) => {
      mount(true, mode);
      const comparison = await screen.findByRole("group", {
        name: `Diff of ${PATH}`,
      });

      await waitFor(() => expect(comparison).toHaveTextContent("context-350"));

      expect(comparison).toHaveTextContent("context-1");
      expect(comparison).toHaveTextContent("before-change");
      expect(comparison).toHaveTextContent("after-change");
      expect(
        screen.queryByRole("button", { name: "Show full diff" }),
      ).toBeNull();
      expect(screen.queryByRole("textbox")).toBeNull();
    },
  );

  it("keeps the normal cap for a host that has not opted into full context", async () => {
    mount(false, "unified");

    expect(
      await screen.findByRole("button", { name: "Show full diff" }),
    ).toBeVisible();
    expect(
      screen.getByRole("group", { name: `Diff of ${PATH}` }),
    ).not.toHaveTextContent("context-350");
  });
});
