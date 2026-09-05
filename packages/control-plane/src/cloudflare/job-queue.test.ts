import { afterEach, describe, expect, it, vi } from "vitest";
import { JOBS, type JobConsumer, type JobDeps, type JobOutcome } from "../jobs";
import { consumeJobBatch, createCloudflareJobQueue, jobKindForQueue } from "./job-queue";

const COMMAND = { version: 1 as const, buildId: "build-1", completionHash: "a".repeat(64) };

function message(body: unknown, attempts = 1) {
  return {
    id: `message-${attempts}`,
    timestamp: new Date(),
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
    retryAll: vi.fn(),
  };
}

function batch(queue: string, ...messages: ReturnType<typeof message>[]): MessageBatch<unknown> {
  return {
    queue,
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown>;
}

/** Stands in for the kind's real consumer, so a batch exercises only the mapping. */
function stubConsumer(kind: keyof typeof JOBS, ...outcomes: JobOutcome[]): JobConsumer {
  const run = vi.fn(async () => outcomes.shift() ?? "ack");
  vi.spyOn(JOBS[kind], "consumer").mockReturnValue({ run } as JobConsumer);
  return { run } as JobConsumer;
}

const deps = {} as JobDeps;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("jobKindForQueue", () => {
  it("reads the kind off the queue a message arrived on", () => {
    expect(jobKindForQueue("open-inspect-github-autofix-prod")).toBe("github.autofix");
    expect(jobKindForQueue("open-inspect-image-build-finalization-prod")).toBe(
      "image_build.finalize"
    );
  });

  it("does not mistake a deployment named for autofix for the autofix queue", () => {
    expect(jobKindForQueue("open-inspect-image-build-finalization-github-autofix-test")).toBe(
      "image_build.finalize"
    );
  });
});

describe("createCloudflareJobQueue", () => {
  it("sends the payload alone, on the kind's own queue", async () => {
    const send = vi.fn(async () => undefined);
    const jobs = createCloudflareJobQueue({
      IMAGE_BUILD_FINALIZATION_QUEUE: { send } as unknown as Queue<typeof COMMAND>,
    });

    await jobs.send({ kind: "image_build.finalize", payload: COMMAND });

    expect(send).toHaveBeenCalledWith(COMMAND);
  });
});

describe("consumeJobBatch", () => {
  it("acknowledges and retries each message on its own outcome", async () => {
    const consumer = stubConsumer("image_build.finalize", "ack", { retry: true, delaySeconds: 90 });
    const acked = message(COMMAND, 1);
    const delayed = message(COMMAND, 2);

    await consumeJobBatch(
      batch("open-inspect-image-build-finalization-prod", acked, delayed),
      deps
    );

    expect(acked.ack).toHaveBeenCalledOnce();
    expect(acked.retry).not.toHaveBeenCalled();
    expect(delayed.retry).toHaveBeenCalledWith({ delaySeconds: 90 });
    expect(consumer.run).toHaveBeenCalledWith(COMMAND, {
      id: "message-1",
      attempts: 1,
      maxAttempts: JOBS["image_build.finalize"].maxAttempts,
    });
  });

  it("gives a plain retry the kind's declared delay", async () => {
    stubConsumer("github.autofix", "retry");
    const queued = message({ version: 1 });

    await consumeJobBatch(batch("open-inspect-github-autofix-prod", queued), deps);

    expect(queued.retry).toHaveBeenCalledWith({
      delaySeconds: JOBS["github.autofix"].retryDelaySeconds,
    });
  });

  it("builds the consumer once for the whole batch", async () => {
    stubConsumer("image_build.finalize");

    await consumeJobBatch(
      batch("open-inspect-image-build-finalization-prod", message(COMMAND), message(COMMAND, 2)),
      deps
    );

    expect(JOBS["image_build.finalize"].consumer).toHaveBeenCalledOnce();
  });
});
