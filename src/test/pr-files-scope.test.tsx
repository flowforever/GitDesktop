import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrFilesPane } from "@/features/pulls/RemotePrViewParts";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { getTransport, installTransport } from "@/lib/transport";

// Expanding a tree folder scrolls its focused row; jsdom supplies no method.
Element.prototype.scrollIntoView ??= () => undefined;

vi.mock("@/features/diff/DiffSurfaceLazy", () => ({
  DiffContent: () => null,
}));

const HEAD = "a".repeat(40);
const FILES = [
  { path: "src/changed.ts", additions: 2, deletions: 1 },
  { path: "src/deleted.ts", additions: 0, deletions: 8 },
];
const snapshot = vi.fn();
const bytes = vi.fn();
let previousTransport: ReturnType<typeof getTransport>;

beforeEach(() => {
  previousTransport = getTransport();
  snapshot.mockReset().mockResolvedValue([
    { path: "src/changed.ts", undecodable: false },
    { path: "src/context.ts", undecodable: false },
  ]);
  bytes.mockReset().mockResolvedValue({
    base64: btoa("export const context = 'MR version';"),
    mime: null,
    tooLarge: false,
    size: 36,
  });
  installTransport({
    async invoke(command, args) {
      if (command === "git_pr_snapshot_files") return snapshot(args);
      if (command === "git_pr_snapshot_file") return bytes(args);
      if (command === "git_objects_present") return true;
      throw new Error(`Unexpected command: ${command}`);
    },
  });
});
afterEach(() => installTransport(previousTransport));

function Harness({ incomplete = false }: { incomplete?: boolean }) {
  const [path, setPath] = useState<string | null>("src/changed.ts");
  return (
    <>
      <output aria-label="Selected MR change">{path}</output>
      <PrFilesPane
        files={FILES}
        effectivePath={path}
        onSelectPath={setPath}
        fileDiff={undefined}
        isPending={false}
        isError={false}
        isFetching={false}
        repoPath="/repo"
        lens="origin"
        number={7}
        blameRev={HEAD}
        provider="gitlab"
        changesIncomplete={incomplete}
      />
    </>
  );
}

async function mount(incomplete = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
  render(
    <QueryClientProvider client={client}>
      <Harness incomplete={incomplete} />
    </QueryClientProvider>,
  );
  const expand = screen.queryByRole("button", { name: "Expand file list" });
  if (expand) await userEvent.click(expand);
}

async function expandSourceFolder() {
  await waitFor(() =>
    expect(screen.queryByText("Loading all files…")).toBeNull(),
  );
  const folder = await screen.findByRole("treeitem", { name: "src" });
  if (folder.getAttribute("aria-expanded") === "false")
    await userEvent.click(folder);
}

describe("MR file scope", () => {
  it("keeps unreadable names distinct and never opens their display spelling", async () => {
    snapshot.mockResolvedValue([
      { path: "src/\uFFFD.ts", undecodable: false },
      { path: "src/\uFFFD.ts", undecodable: true },
      { path: "src/\uFFFD.ts", undecodable: true },
    ]);
    await mount();
    fireEvent.click(
      screen.getByRole("button", { name: "File scope: MR changes" }),
    );
    await expandSourceFolder();
    const unreadable = await screen.findAllByRole("treeitem", {
      name: /Unreadable name/,
    });
    expect(unreadable).toHaveLength(2);
    for (const row of unreadable) {
      expect(row).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(row);
    }
    expect(bytes).not.toHaveBeenCalled();
    const readable = screen.getByRole("treeitem", {
      name: /\uFFFD.ts.*Unchanged/,
    });
    await userEvent.click(readable);
    await screen.findByRole("region", { name: "Source of src/\uFFFD.ts" });
    expect(readable).toHaveAttribute("aria-selected", "true");
    for (const row of unreadable)
      expect(row).toHaveAttribute("aria-selected", "false");
  });

  it("loads all files on demand and restores the selected MR change when toggled back", async () => {
    const user = userEvent.setup();
    await mount();
    const toggle = screen.getByRole("button", {
      name: "File scope: MR changes",
    });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(snapshot).not.toHaveBeenCalled();
    expect(screen.queryByRole("treeitem", { name: /context.ts/ })).toBeNull();
    await user.click(toggle);
    await expandSourceFolder();

    const context = await screen.findByRole("treeitem", { name: /context.ts/ });
    expect(context).toHaveTextContent("Unchanged");
    expect(within(context).queryByLabelText(/lines added/)).toBeNull();
    expect(screen.getByRole("treeitem", { name: /deleted.ts/ })).toBeVisible();
    expect(snapshot).toHaveBeenCalledWith({
      repoPath: "/repo",
      number: 7,
      headSha: HEAD,
      lens: "origin",
    });
    await user.click(context);
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Source of src/context.ts" }),
      ).toHaveTextContent("export const context = 'MR version';"),
    );
    expect(bytes).toHaveBeenCalledWith({
      repoPath: "/repo",
      headSha: HEAD,
      filePath: "src/context.ts",
      lens: "origin",
    });
    expect(screen.getByLabelText("Selected MR change")).toHaveTextContent(
      "src/changed.ts",
    );
    await user.click(toggle);
    await expandSourceFolder();

    expect(toggle).toHaveAccessibleName("File scope: MR changes");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("treeitem", { name: /context.ts/ })).toBeNull();
    expect(
      screen.getByRole("treeitem", { name: /changed.ts/ }),
    ).toHaveAttribute("aria-selected", "true");
  });

  it("keeps MR changes available when the full tree fails and retries the same snapshot", async () => {
    snapshot.mockRejectedValueOnce(new Error("Fetch unavailable"));
    await mount();
    fireEvent.click(
      screen.getByRole("button", { name: "File scope: MR changes" }),
    );
    const retry = await screen.findByRole("button", {
      name: "Retry loading all files",
    });
    await expandSourceFolder();
    expect(screen.getByRole("treeitem", { name: /changed.ts/ })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "File scope: All files" }),
    ).toBeEnabled();
    fireEvent.click(retry);
    await expandSourceFolder();
    await screen.findByRole("treeitem", { name: /context.ts/ });
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it("avoids declaring unlisted files unchanged when MR changes are incomplete", async () => {
    await mount(true);
    fireEvent.click(
      screen.getByRole("button", { name: "File scope: MR changes" }),
    );
    await expandSourceFolder();
    const context = await screen.findByRole("treeitem", { name: /context.ts/ });
    expect(context).toHaveTextContent("Not in loaded changes");
    expect(context).not.toHaveTextContent("Unchanged");
    await userEvent.click(context);
    await waitFor(() =>
      expect(
        within(
          screen.getByRole("region", { name: "Source of src/context.ts" }),
        ).getByText("Not in loaded changes"),
      ).toBeVisible(),
    );
  });
});
