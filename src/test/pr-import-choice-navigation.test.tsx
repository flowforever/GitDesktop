import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCodeImportCandidates } from "@/features/pulls/code-import-resolution";
import { PrImportTargetPicker } from "@/features/pulls/PrImportTargetPicker";
import { usePrImportNavigation } from "@/features/pulls/usePrImportNavigation";
import { gitPrSnapshotFiles } from "@/lib/git/api/pr-snapshot";
import { useUiStore } from "@/lib/stores/ui";

vi.mock("@/features/pulls/code-import-resolution", () => ({
  resolveCodeImportCandidates: vi.fn(),
}));
vi.mock("@/lib/git/api/pr-snapshot", async (original) => ({
  ...(await original<typeof import("@/lib/git/api/pr-snapshot")>()),
  gitPrSnapshotFiles: vi.fn(),
}));
const HEAD = "a".repeat(40);
const PATHS = ["pkg/a.go", "pkg/b.go"];
const resolve = vi.mocked(resolveCodeImportCandidates);
const clients: QueryClient[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(gitPrSnapshotFiles).mockResolvedValue(
    ["src/main.go", ...PATHS].map((path) => ({ path, undecodable: false })),
  );
  resolve.mockResolvedValue(PATHS);
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

function Harness({
  enabled = true,
  path = "src/main.go",
  onNavigate,
}: {
  enabled?: boolean;
  path?: string;
  onNavigate: (path: string) => void;
}) {
  const imports = usePrImportNavigation({
    repoPath: "/repo",
    number: 7,
    lens: "origin",
    headSha: HEAD,
    path,
    enabled,
    comparisonSupported: true,
    onNavigate,
  });
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void imports.onOpen("example.test/project/pkg", "src/main.go")
        }
      >
        Follow package import
      </button>
      {imports.choices && (
        <PrImportTargetPicker
          specifier={imports.choices.specifier}
          paths={imports.choices.paths}
          onChoose={imports.chooseTarget}
          onClose={imports.dismissChoices}
        />
      )}
    </>
  );
}
function mount() {
  const onNavigate = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      <Harness onNavigate={onNavigate} />
    </QueryClientProvider>,
  );
  return {
    onNavigate,
    update: (props: { enabled?: boolean; path?: string }) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <Harness onNavigate={onNavigate} {...props} />
        </QueryClientProvider>,
      ),
  };
}

describe("snapshot import choices", () => {
  it("asks which package file to open and navigates only to the selected target", async () => {
    const { onNavigate } = mount();
    await userEvent.click(
      screen.getByRole("button", { name: "Follow package import" }),
    );
    await screen.findByRole("dialog", { name: "Choose an import target" });
    expect(onNavigate).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("option", { name: PATHS[1] }));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith(PATHS[1]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens a single proven target directly", async () => {
    resolve.mockResolvedValueOnce([PATHS[0]]);
    const { onNavigate } = mount();
    await userEvent.click(
      screen.getByRole("button", { name: "Follow package import" }),
    );
    await waitFor(() =>
      expect(onNavigate).toHaveBeenCalledExactlyOnceWith(PATHS[0]),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the current file when the package choice is dismissed", async () => {
    const { onNavigate } = mount();
    await userEvent.click(
      screen.getByRole("button", { name: "Follow package import" }),
    );
    await screen.findByRole("dialog", { name: "Choose an import target" });
    await userEvent.keyboard("{Escape}");
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("retires choices when another user navigation happens", async () => {
    const { onNavigate } = mount();
    await userEvent.click(
      screen.getByRole("button", { name: "Follow package import" }),
    );
    await screen.findByRole("dialog", { name: "Choose an import target" });
    act(() => useUiStore.getState().noteUserInteraction());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("retires a pending resolution across a file change and return", async () => {
    let finish!: (paths: string[]) => void;
    resolve.mockReturnValueOnce(
      new Promise((done) => {
        finish = done;
      }),
    );
    const view = mount();
    await userEvent.click(
      screen.getByRole("button", { name: "Follow package import" }),
    );
    await waitFor(() => expect(resolve).toHaveBeenCalledOnce());
    view.update({ path: "other.go" });
    view.update({ path: "src/main.go" });
    await act(async () => finish(PATHS));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(view.onNavigate).not.toHaveBeenCalled();
  });
});
