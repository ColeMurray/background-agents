import { describe, expect, it, vi } from "vitest";
import type { SqlDatabase } from "../db/sql-database";
import type { JobDeps } from "../jobs";
import type { Logger } from "../logger";
import type { Env } from "../types";
import { handleImageBuildFinalization } from "./finalization-consumer";
import { ImageBuildFinalizer } from "./finalizer";

vi.mock("./finalizer", () => ({
  ImageBuildFinalizer: vi.fn(function () {
    return { process };
  }),
}));
vi.mock("./provider-factory", () => ({ createImageBuildAdapterFactory: vi.fn(() => ({})) }));

const { process } = vi.hoisted(() => ({ process: vi.fn() }));

const JOB = { version: 1 as const, buildId: "build-1", completionHash: "a".repeat(64) };

const send = vi.fn(async () => undefined);

function deps(): JobDeps {
  return {
    env: { LOG_LEVEL: "error", JOBS: { send } } as unknown as Env,
    db: {} as SqlDatabase,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
    correlation: { trace_id: "message-1", request_id: "message-1" },
  };
}

describe("handleImageBuildFinalization", () => {
  it("acknowledges completed work, processed under the delivery's correlation", async () => {
    const delivery = deps();
    process.mockResolvedValueOnce({ type: "completed" });

    const outcome = await handleImageBuildFinalization(
      JOB,
      { attempts: 1, maxAttempts: 13 },
      delivery
    );

    expect(outcome).toBe("ack");
    expect(ImageBuildFinalizer).toHaveBeenCalledOnce();
    expect(process).toHaveBeenCalledWith(JOB, delivery.correlation);
  });

  it("asks for a retry after the delay the finalizer names while the build is busy", async () => {
    process.mockResolvedValueOnce({ type: "retry", delayMs: 365_000 });

    const outcome = await handleImageBuildFinalization(
      JOB,
      { attempts: 2, maxAttempts: 13 },
      deps()
    );

    expect(outcome).toEqual({ retry: true, delayMs: 365_000 });
  });
  it.each([5, 12])(
    "keeps the host's retry budget for a pending operation on delivery %i of 13",
    async (attempts) => {
      send.mockClear();
      process.mockResolvedValueOnce({
        type: "retry",
        delayMs: 30_000,
        reason: "pending_operation",
      });

      const outcome = await handleImageBuildFinalization(
        JOB,
        { attempts, maxAttempts: 13 },
        deps()
      );

      expect(outcome).toEqual({ retry: true, delayMs: 30_000 });
      expect(send).not.toHaveBeenCalled();
    }
  );

  it("republishes a pending operation on the last delivery instead of dead-lettering it", async () => {
    send.mockClear();
    process.mockResolvedValueOnce({
      type: "retry",
      delayMs: 30_000,
      reason: "pending_operation",
    });

    // `attempts` is 1-based and `maxAttempts` counts the first delivery, so
    // this is the delivery a retry would dead-letter.
    const outcome = await handleImageBuildFinalization(
      JOB,
      { attempts: 13, maxAttempts: 13 },
      deps()
    );

    // A capture outlives a budget sized for lease contention; the operation's
    // own fixed deadline is what ends the wait, not the delivery count.
    expect(outcome).toBe("ack");
    expect(send).toHaveBeenCalledWith(
      { kind: "image_build.finalize", payload: JOB },
      { delayMs: 30_000 }
    );
  });

  it("spends the host's budget on a lease-contention retry even on the last delivery", async () => {
    send.mockClear();
    process.mockResolvedValueOnce({ type: "retry", delayMs: 20_000 });

    const outcome = await handleImageBuildFinalization(
      JOB,
      { attempts: 13, maxAttempts: 13 },
      deps()
    );

    expect(outcome).toEqual({ retry: true, delayMs: 20_000 });
    expect(send).not.toHaveBeenCalled();
  });
});
