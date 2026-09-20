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
  it("rejects preservation recovery when no handler is configured", async () => {
    await expect(createFacade().recoverPreservation("retry")).rejects.toThrow(
      "Preservation recovery is not configured"
    );
  });

  it("delegates preservation recovery to the configured handler", async () => {
    const recover = vi.fn(async () => {});

    await createFacade(recover).recoverPreservation("restore_saved");

    expect(recover).toHaveBeenCalledWith("restore_saved");
  });

  it("propagates configured preservation recovery failures", async () => {
    const recover = vi.fn(async () => {
      throw new Error("retry failed");
    });

    await expect(createFacade(recover).recoverPreservation("retry")).rejects.toThrow(
      "retry failed"
    );
  });
});
