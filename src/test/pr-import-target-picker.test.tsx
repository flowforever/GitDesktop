import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PrImportTargetPicker } from "@/features/pulls/PrImportTargetPicker";

const PATHS = [
  "internal/work/client.go",
  "internal/work/service.go",
  "internal/work/types.go",
];
const mount = () => {
  const onChoose = vi.fn();
  const onClose = vi.fn();
  render(
    <PrImportTargetPicker
      specifier="example.test/project/internal/work"
      paths={PATHS}
      onChoose={onChoose}
      onClose={onClose}
    />,
  );
  return { onChoose, onClose };
};

describe("import package file choice", () => {
  it("shows the module and full candidate paths without choosing an arbitrary file", async () => {
    const { onChoose } = mount();
    const dialog = await screen.findByRole("dialog", {
      name: "Choose an import target",
    });
    expect(dialog).toHaveTextContent("example.test/project/internal/work");
    for (const path of PATHS)
      expect(within(dialog).getByRole("option", { name: path })).toBeVisible();
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("filters a package's source files and opens the matching path with Enter", async () => {
    const { onChoose } = mount();
    const filter = await screen.findByRole("combobox", {
      name: "Filter import targets",
    });
    await userEvent.type(filter, "service");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await userEvent.keyboard("{Enter}");
    expect(onChoose).toHaveBeenCalledExactlyOnceWith(PATHS[1]);
  });

  it("moves through candidates with arrows and opens only after confirmation", async () => {
    const { onChoose } = mount();
    const filter = await screen.findByRole("combobox", {
      name: "Filter import targets",
    });
    filter.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(onChoose).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(onChoose).toHaveBeenCalledExactlyOnceWith(PATHS[1]);
  });

  it("does not open a file when dismissed or when the filter has no matches", async () => {
    const { onChoose, onClose } = mount();
    const filter = await screen.findByRole("combobox", {
      name: "Filter import targets",
    });
    await userEvent.type(filter, "missing-file");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matching files")).toBeVisible();
    await userEvent.keyboard("{Enter}{Escape}");
    expect(onChoose).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("opens the clicked source file", async () => {
    const { onChoose } = mount();
    await userEvent.click(
      await screen.findByRole("option", { name: PATHS[2] }),
    );
    expect(onChoose).toHaveBeenCalledExactlyOnceWith(PATHS[2]);
  });
});
