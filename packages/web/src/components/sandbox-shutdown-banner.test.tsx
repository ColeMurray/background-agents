// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SandboxShutdownState,
  ShutdownRecoveryAction,
} from "@open-inspect/shared/types/sandbox-shutdown";
import { SandboxShutdownBanner as Banner } from "./sandbox-shutdown-banner";

const acceptedRecovery = () =>
  vi.fn(async (action: ShutdownRecoveryAction) => ({ ok: true as const, action }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SandboxShutdownBanner", () => {
  it("renders no banner for normal execution", () => {
    const { container } = render(
      <Banner shutdown={{ phase: "running", expiresAtMs: null, drainAtMs: null }} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it.each(["draining", "prepared", "capturing", "retiring", "restoring"] as const)(
    "stays silent during a routine %s phase",
    (phase) => {
      const { container } = render(
        <Banner
          shutdown={{
            phase,
            expiresAtMs: 2,
            drainAtMs: 1,
            reason: "inactivity_timeout",
            hasRecoveryPoint: true,
          }}
          onRecover={acceptedRecovery()}
        />
      );
      expect(container).toBeEmptyDOMElement();
    }
  );

  it("offers to resume queued work after an active prompt was interrupted and saved", () => {
    const onRecover = acceptedRecovery();
    render(
      <Banner
        shutdown={{
          phase: "saved",
          expiresAtMs: 2,
          drainAtMs: 1,
          hasRecoveryPoint: true,
          continuationPaused: true,
          availableRecoveryActions: ["restore_saved"],
        }}
        onRecover={onRecover}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "interrupted prompts will not replay automatically"
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Partial state was saved. Queued work will wait until you resume"
    );
    expect(onRecover).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Resume queued work" }));
    expect(onRecover).toHaveBeenCalledTimes(1);
    expect(onRecover).toHaveBeenCalledWith("restore_saved");
  });

  it("stays silent for a saved shutdown that did not pause continuation", () => {
    const { container } = render(
      <Banner
        shutdown={{
          phase: "saved",
          expiresAtMs: 2,
          drainAtMs: 1,
          hasRecoveryPoint: true,
        }}
        onRecover={acceptedRecovery()}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it.each(["inactivity_timeout", "sandbox_lifetime_expiring"])(
    "stays silent, and leaks no internal reason, for a routine %s save",
    (reason) => {
      const { container } = render(
        <Banner
          shutdown={{
            phase: "saved",
            expiresAtMs: 2,
            drainAtMs: 1,
            reason,
            hasRecoveryPoint: true,
          }}
        />
      );

      expect(container).toBeEmptyDOMElement();
    }
  );

  it("clears the paused-continuation banner through resume and the restore that follows", async () => {
    const onRecover = acceptedRecovery();
    const paused: SandboxShutdownState = {
      phase: "saved",
      reason: "sandbox_lifetime_expiring",
      expiresAtMs: 2,
      drainAtMs: 1,
      savedAtMs: 1,
      hasRecoveryPoint: true,
      continuationPaused: true,
      availableRecoveryActions: ["restore_saved"],
    };
    const { container, rerender } = render(<Banner shutdown={paused} onRecover={onRecover} />);

    fireEvent.click(screen.getByRole("button", { name: "Resume queued work" }));
    await waitFor(() => expect(onRecover).toHaveBeenCalledWith("restore_saved"));

    // recover() clears the pause and keeps the saved phase, which no longer offers an action.
    rerender(
      <Banner
        shutdown={{ ...paused, continuationPaused: false, availableRecoveryActions: [] }}
        onRecover={onRecover}
      />
    );
    expect(container).toBeEmptyDOMElement();

    // reserveStartup() then starts a fresh record for the restoring generation.
    rerender(
      <Banner
        shutdown={{
          phase: "restoring",
          expiresAtMs: null,
          drainAtMs: null,
          savedAtMs: 1,
          hasRecoveryPoint: true,
          continuationPaused: false,
          availableRecoveryActions: [],
        }}
        onRecover={onRecover}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows paused-continuation information without an action when recovery is unavailable", () => {
    render(
      <Banner
        shutdown={{
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
        shutdown={{
          phase: "saved",
          expiresAtMs: 2,
          drainAtMs: 1,
          continuationPaused: true,
        }}
        onRecover={acceptedRecovery()}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "interrupted prompts will not replay automatically"
    );
    expect(screen.queryByRole("button", { name: "Resume queued work" })).not.toBeInTheDocument();
  });

  it.each(["failed", "unknown"] as const)(
    "keeps %s visible as an error with its safe detail",
    (phase) => {
      render(
        <Banner
          shutdown={{
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

  it("offers bounded failure recovery and confirms restoring older state", async () => {
    const onRecover = acceptedRecovery();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <Banner
        shutdown={{
          phase: "failed",
          expiresAtMs: 2,
          drainAtMs: 1,
          hasRecoveryPoint: true,
          availableRecoveryActions: ["retry", "restore_saved"],
        }}
        onRecover={onRecover}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry shutdown" }));
    expect(onRecover).toHaveBeenCalledWith("retry");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry shutdown" })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole("button", { name: "Restore saved state" }));
    expect(confirm).toHaveBeenCalledWith(
      "Restore the last saved sandbox state? Changes since that save may be lost."
    );
    expect(onRecover).not.toHaveBeenCalledWith("restore_saved");
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Restore saved state" }));
    expect(onRecover).toHaveBeenCalledWith("restore_saved");
  });

  it.each([undefined, [] as ShutdownRecoveryAction[]])(
    "fails closed when projected recovery actions are %s even if a receipt exists",
    (availableRecoveryActions) => {
      render(
        <Banner
          shutdown={{
            phase: "failed",
            expiresAtMs: 2,
            drainAtMs: 1,
            hasRecoveryPoint: true,
            availableRecoveryActions,
          }}
          onRecover={acceptedRecovery()}
        />
      );

      expect(screen.queryByRole("button", { name: "Retry shutdown" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Restore saved state" })).not.toBeInTheDocument();
    }
  );

  it("disables all recovery controls while pending and shows an unconfirmed result", async () => {
    let settle!: (result: { ok: false; reason: "timeout" }) => void;
    const onRecover = vi.fn(
      () =>
        new Promise<{ ok: false; reason: "timeout" }>((resolve) => {
          settle = resolve;
        })
    );
    render(
      <Banner
        shutdown={{
          phase: "failed",
          expiresAtMs: 2,
          drainAtMs: 1,
          availableRecoveryActions: ["retry", "restore_saved"],
        }}
        onRecover={onRecover}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry shutdown" }));
    expect(screen.getByRole("button", { name: "Retrying shutdown…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Restore saved state" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retrying shutdown…" }));
    expect(onRecover).toHaveBeenCalledOnce();

    settle({ ok: false, reason: "timeout" });
    await waitFor(() =>
      expect(
        screen.getByText(
          "Recovery was not confirmed. Check the current sandbox state before retrying."
        )
      ).toBeInTheDocument()
    );
  });

  it("clears pending and safely reports an unexpected callback rejection", async () => {
    render(
      <Banner
        shutdown={{
          phase: "failed",
          expiresAtMs: 2,
          drainAtMs: 1,
          availableRecoveryActions: ["retry"],
        }}
        onRecover={vi.fn(async () => {
          throw new Error("unexpected");
        })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry shutdown" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry shutdown" })).toBeEnabled()
    );
    expect(screen.getByText(/Recovery was not confirmed/)).toBeInTheDocument();
  });

  it("shows a definite server rejection separately from an unconfirmed request", async () => {
    render(
      <Banner
        shutdown={{
          phase: "failed",
          expiresAtMs: 2,
          drainAtMs: 1,
          availableRecoveryActions: ["retry"],
        }}
        onRecover={vi.fn(async () => ({
          ok: false as const,
          reason: "rejected" as const,
          message: "Recovery is no longer eligible",
        }))}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry shutdown" }));
    expect(await screen.findByText("Recovery is no longer eligible")).toBeInTheDocument();
    expect(screen.queryByText(/Recovery was not confirmed/)).not.toBeInTheDocument();
  });
});
