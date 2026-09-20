import { describe, expect, it, vi } from "vitest";
import { SessionClientCommandFacade } from "./client-command-facade";

function createFacade(recover?: (action: "retry" | "restore_saved") => Promise<void>) {
  return new SessionClientCommandFacade(
    {} as never,
    {} as never,
    vi.fn(async () => {}),
    {} as never,
    {} as never,
    recover
  );
}

describe("SessionClientCommandFacade", () => {
  it("rejects shutdown recovery when no handler is configured", async () => {
    await expect(createFacade().recoverShutdown("retry")).rejects.toThrow(
      "Shutdown recovery is not configured"
    );
  });

  it("delegates shutdown recovery to the configured handler", async () => {
    const recover = vi.fn(async () => {});

    await createFacade(recover).recoverShutdown("restore_saved");

    expect(recover).toHaveBeenCalledWith("restore_saved");
  });

  it("propagates configured shutdown recovery failures", async () => {
    const recover = vi.fn(async () => {
      throw new Error("retry failed");
    });

    await expect(createFacade(recover).recoverShutdown("retry")).rejects.toThrow("retry failed");
  });
});
