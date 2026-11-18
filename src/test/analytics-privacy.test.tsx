import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const posthog = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  startSessionRecording: vi.fn(),
  stopSessionRecording: vi.fn(),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("posthog-js", () => ({ default: posthog }));

function ThrowingChild({ fail }: { fail: boolean }) {
  if (fail) throw new Error("Could not load /private/project/source.ts");
  return <p>Ready</p>;
}

describe("analytics privacy", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("VITE_POSTHOG_KEY", "phc_privacy_test");
    vi.stubEnv("VITE_POSTHOG_HOST", "https://posthog.invalid");
    mockIPC((cmd) => {
      if (cmd === "plugin:store|load") return 1;
      if (cmd === "plugin:store|get") return ["privacy-test-device", true];
      throw new Error(`Unexpected command: ${cmd}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    clearMocks();
  });

  it("keeps exception and console capture off when replay is enabled", async () => {
    const { initAnalytics } = await import("@/lib/analytics");
    await initAnalytics(true, true);

    expect(posthog.init).toHaveBeenCalledWith(
      "phc_privacy_test",
      expect.objectContaining({
        capture_exceptions: false,
        enable_recording_console_log: false,
      }),
    );
    expect(posthog.startSessionRecording).toHaveBeenCalledOnce();
  });

  it("continues sending anonymous usage events", async () => {
    const { initAnalytics, track } = await import("@/lib/analytics");
    await initAnalytics(true, false);

    track({ name: "repo_opened", properties: { source: "picker" } });

    expect(posthog.capture).toHaveBeenCalledExactlyOnceWith("repo_opened", {
      source: "picker",
    });
  });

  it("shows errors and recovers locally without reporting them", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { initAnalytics } = await import("@/lib/analytics");
    await initAnalytics(true, true);
    const { ErrorBoundary } = await import("@/components/ErrorBoundary");
    const view = render(
      <ErrorBoundary>
        <ThrowingChild fail />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong")).toBeVisible();
    expect(
      screen.getByText("Could not load /private/project/source.ts"),
    ).toBeVisible();
    expect(posthog.capture).not.toHaveBeenCalled();

    view.rerender(
      <ErrorBoundary>
        <ThrowingChild fail={false} />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(screen.getByText("Ready")).toBeVisible();
    expect(posthog.capture).not.toHaveBeenCalled();
  });
});
