// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxPreservationBanner } from "./sandbox-preservation-banner";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SandboxPreservationBanner", () => {
  it("renders no banner for normal execution", () => {
    const { container } = render(
      <SandboxPreservationBanner
        preservation={{ phase: "running", expiresAtMs: null, drainAtMs: null }}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ["draining", "Stopping the prompt"],
    ["prepared", "Prompt stopped"],
    ["capturing", "Saving final sandbox state"],
    ["retiring", "Confirming sandbox shutdown"],
    ["saved", "Sandbox saved and stopped"],
  ] as const)("shows the %s phase", (phase, text) => {
    render(<SandboxPreservationBanner preservation={{ phase, expiresAtMs: 2, drainAtMs: 1 }} />);
    expect(screen.getByRole("status")).toHaveTextContent(text);
  });

  it.each(["failed", "unknown"] as const)(
    "keeps %s visible as an error with its safe detail",
    (phase) => {
      render(
        <SandboxPreservationBanner
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
      <SandboxPreservationBanner
        preservation={{
          phase: "failed",
          expiresAtMs: 2,
          drainAtMs: 1,
          hasRecoveryPoint: true,
        }}
        onRecover={onRecover}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry preservation" }));
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
