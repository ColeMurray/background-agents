// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxShutdownBanner as Banner } from "./sandbox-shutdown-banner";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SandboxShutdownBanner", () => {
  it("renders no banner for normal execution", () => {
    const { container } = render(
      <Banner preservation={{ phase: "running", expiresAtMs: null, drainAtMs: null }} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ["draining", "Stopping the prompt"],
    ["prepared", "Prompt stopped"],
    ["capturing", "Saving final sandbox state"],
    ["retiring", "Confirming sandbox shutdown"],
    ["saved", "Sandbox saved and stopped"],
    ["restoring", "Restoring the saved sandbox state"],
  ] as const)("shows the %s phase", (phase, text) => {
    render(<Banner preservation={{ phase, expiresAtMs: 2, drainAtMs: 1 }} />);
    expect(screen.getByRole("status")).toHaveTextContent(text);
  });

  it("offers to resume queued work after an active prompt was interrupted and saved", () => {
    const onRecover = vi.fn();
    render(
      <Banner
        preservation={{
          phase: "saved",
          expiresAtMs: 2,
          drainAtMs: 1,
          hasRecoveryPoint: true,
          continuationPaused: true,
        }}
        onRecover={onRecover}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "The previous prompt was interrupted and will not replay automatically"
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Partial work was saved. Queued work will wait until you resume"
    );
    expect(onRecover).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Resume queued work" }));
    expect(onRecover).toHaveBeenCalledTimes(1);
    expect(onRecover).toHaveBeenCalledWith("restore_saved");
  });

  it("does not offer resume when a saved shutdown did not pause continuation", () => {
    render(
      <Banner
        preservation={{
          phase: "saved",
          expiresAtMs: 2,
          drainAtMs: 1,
          hasRecoveryPoint: true,
        }}
        onRecover={vi.fn()}
      />
    );

    expect(screen.queryByRole("button", { name: "Resume queued work" })).not.toBeInTheDocument();
  });

  it("clears the paused-continuation action when newer state no longer requires it", () => {
    const onRecover = vi.fn();
    const { rerender } = render(
      <Banner
        preservation={{
          phase: "saved",
          expiresAtMs: 2,
          drainAtMs: 1,
          hasRecoveryPoint: true,
          continuationPaused: true,
        }}
        onRecover={onRecover}
      />
    );
    expect(screen.getByRole("button", { name: "Resume queued work" })).toBeInTheDocument();

    rerender(
      <Banner
        preservation={{
          phase: "restoring",
          expiresAtMs: 2,
          drainAtMs: 1,
          hasRecoveryPoint: true,
          continuationPaused: true,
        }}
        onRecover={onRecover}
      />
    );

    expect(screen.queryByRole("button", { name: "Resume queued work" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Restoring the saved sandbox state");
  });

  it("shows paused-continuation information without an action when recovery is unavailable", () => {
    render(
      <Banner
        preservation={{
          phase: "saved",
          expiresAtMs: 2,
          drainAtMs: 1,
          hasRecoveryPoint: true,
          continuationPaused: true,
        }}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent("Queued work will wait until you resume");
    expect(screen.queryByRole("button", { name: "Resume queued work" })).not.toBeInTheDocument();
  });

  it("keeps the paused-continuation warning visible without a recovery point", () => {
    render(
      <Banner
        preservation={{
          phase: "saved",
          expiresAtMs: 2,
          drainAtMs: 1,
          continuationPaused: true,
        }}
        onRecover={vi.fn()}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "The previous prompt was interrupted and will not replay automatically"
    );
    expect(screen.queryByRole("button", { name: "Resume queued work" })).not.toBeInTheDocument();
  });

  it.each(["failed", "unknown"] as const)(
    "keeps %s visible as an error with its safe detail",
    (phase) => {
      render(
        <Banner
          preservation={{
            phase,
            expiresAtMs: 2,
            drainAtMs: 1,
            error: "provider_capture_failed",
          }}
        />
      );
      expect(screen.getByRole("alert")).toHaveTextContent("provider_capture_failed");
    }
  );

  it("offers bounded failure recovery and confirms restoring older state", () => {
    const onRecover = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <Banner
        preservation={{
          phase: "failed",
          expiresAtMs: 2,
          drainAtMs: 1,
          hasRecoveryPoint: true,
        }}
        onRecover={onRecover}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry shutdown" }));
    expect(onRecover).toHaveBeenCalledWith("retry");
    fireEvent.click(screen.getByRole("button", { name: "Restore saved state" }));
    expect(confirm).toHaveBeenCalledWith(
      "Restore the last saved sandbox state? Changes since that save may be lost."
    );
    expect(onRecover).not.toHaveBeenCalledWith("restore_saved");
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Restore saved state" }));
    expect(onRecover).toHaveBeenCalledWith("restore_saved");
  });
});
