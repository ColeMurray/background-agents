import { describe, expect, it, vi } from "vitest";
import { JOBS, type JobDelivery } from "../jobs";
import { IMAGE_BUILD_FINALIZATION_RETRY_DELAY_SECONDS } from "./finalizer";
import { imageBuildFinalizationConsumer } from "./finalization-consumer";

const COMMAND = { version: 1, buildId: "build-1", completionHash: "a".repeat(64) };

function delivery(attempts = 1): JobDelivery {
  return { id: "job-1", attempts, maxAttempts: JOBS["image_build.finalize"].maxAttempts };
}

describe("image build finalization consumer", () => {
  it("acknowledges completed work, naming the job in the finalizer's correlation", async () => {
    const process = vi.fn(async () => ({ type: "completed" as const }));

    const outcome = await imageBuildFinalizationConsumer(process).run(COMMAND, delivery());

    expect(outcome).toBe("ack");
    expect(process).toHaveBeenCalledWith(COMMAND, "job-1");
  });

  it("retries busy or failed processing for as long as the finalizer asks", async () => {
    const process = vi.fn(async () => ({ type: "retry" as const, delaySeconds: 365 }));

    const outcome = await imageBuildFinalizationConsumer(process).run(COMMAND, delivery());

    expect(outcome).toEqual({ retry: true, delaySeconds: 365 });
  });

  it("retries a throwing finalizer after the kind's own delay", async () => {
    const process = vi.fn(async () => {
      throw new Error("provider unavailable");
    });

    const outcome = await imageBuildFinalizationConsumer(process).run(COMMAND, delivery());

    expect(outcome).toEqual({
      retry: true,
      delaySeconds: IMAGE_BUILD_FINALIZATION_RETRY_DELAY_SECONDS,
    });
  });

  it("discards a malformed command rather than redelivering it forever", async () => {
    const process = vi.fn();

    const outcome = await imageBuildFinalizationConsumer(process).run(
      { buildId: "build-2", callbackToken: "secret" },
      delivery()
    );

    expect(outcome).toBe("ack");
    expect(process).not.toHaveBeenCalled();
  });
});
