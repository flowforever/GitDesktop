// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewUpdateNotice } from "@/features/updates/PreviewUpdateNotice";

const { check, getIdentifier, isTauri } = vi.hoisted(() => ({
  check: vi.fn(),
  getIdentifier: vi.fn(),
  isTauri: vi.fn(),
}));
vi.mock("@tauri-apps/api/app", () => ({ getIdentifier }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  getIdentifier.mockResolvedValue("com.thebguy.gitdesktop.preview");
});

getIdentifier.mockResolvedValue("com.thebguy.gitdesktop.preview");

describe("signed preview updates", () => {
  it("checks on launch but waits for a click before downloading and installing", async () => {
    isTauri.mockReturnValue(true);
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    check.mockResolvedValue({ version: "1.0.2", downloadAndInstall, close });
    const { unmount } = render(<PreviewUpdateNotice />);
    const install = await screen.findByRole("button", {
      name: "Download and install",
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText("GitDesktop Preview 1.0.2 is available."),
    ).toBeVisible();
    expect(downloadAndInstall).not.toHaveBeenCalled();
    await userEvent.setup().click(install);
    expect(await screen.findByText(/Update installed/)).toBeVisible();
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    unmount();
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports installation errors and lets the user explicitly retry", async () => {
    isTauri.mockReturnValue(true);
    const downloadAndInstall = vi
      .fn()
      .mockRejectedValue(new Error("bad signature"));
    check.mockResolvedValue({
      version: "1.0.2",
      downloadAndInstall,
      close: vi.fn().mockResolvedValue(undefined),
    });
    const user = userEvent.setup();
    render(<PreviewUpdateNotice />);
    await user.click(
      await screen.findByRole("button", { name: "Download and install" }),
    );
    expect(await screen.findByText(/could not be installed/)).toBeVisible();
    expect(downloadAndInstall).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(downloadAndInstall).toHaveBeenCalledTimes(2);
  });

  it("never checks in a browser", () => {
    isTauri.mockReturnValue(false);
    render(<PreviewUpdateNotice />);
    expect(check).not.toHaveBeenCalled();
  });

  it("checks the separately identified staging app", async () => {
    isTauri.mockReturnValue(true);
    getIdentifier.mockResolvedValue("com.thebguy.gitdesktop.preview.staging");
    check.mockResolvedValue(null);
    render(<PreviewUpdateNotice />);
    await waitFor(() => expect(check).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("never checks a stable app even when mounted", async () => {
    isTauri.mockReturnValue(true);
    getIdentifier.mockResolvedValue("com.thebguy.gitdesktop");
    render(<PreviewUpdateNotice />);
    await waitFor(() => expect(getIdentifier).toHaveBeenCalledOnce());
    expect(check).not.toHaveBeenCalled();
  });

  it("ignores an unavailable feed without showing an install option", async () => {
    isTauri.mockReturnValue(true);
    check.mockRejectedValue(new Error("offline"));
    render(<PreviewUpdateNotice />);
    await waitFor(() => expect(check).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button")).toBeNull();
  });
});
