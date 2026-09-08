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

function deps(): JobDeps {
  return {
    env: { LOG_LEVEL: "error" } as unknown as Env,
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
});
