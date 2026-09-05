import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubAutofixEnvelope } from "@open-inspect/shared";
import { handleAutofixJob } from "./autofix/handler";
import type { SqlDatabase } from "./db/sql-database";
import { consumeJobBatch } from "./cloudflare/job-queue";
import { handleImageBuildFinalization } from "./image-builds/finalization-consumer";
import { IMAGE_BUILD_FINALIZATION_RETRY_DELAY_MS } from "./image-builds/finalizer";
import type { Logger } from "./logger";
import { JOB_KINDS, deliverJob, type Job, type JobDeps, type JobKind } from "./jobs";
import type { Env } from "./types";

// The handler bodies are mocked; the table's schemas and retry policies stay
// the production values so the tests below read what the hosts really use.
vi.mock("./autofix/handler", () => ({ handleAutofixJob: vi.fn() }));
vi.mock("./image-builds/finalization-consumer", () => ({ handleImageBuildFinalization: vi.fn() }));

const FINALIZE_PAYLOAD = {
  version: 1 as const,
  buildId: "build-1",
  completionHash: "a".repeat(64),
};

const AUTOFIX_PAYLOAD: GitHubAutofixEnvelope = {
  version: 1,
  eventType: "issue_comment",
  action: "created",
  deliveryId: "delivery-1",
  providerObject: { kind: "pr_comment", id: "1234" },
  repository: { id: "99", owner: "acme", name: "widgets" },
  pullRequestNumber: 42,
  receivedAt: "2026-07-30T05:00:00.000Z",
};

function fakeDeps(): JobDeps & { log: { error: ReturnType<typeof vi.fn> } } {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    env: { LOG_LEVEL: "error", DEPLOYMENT_NAME: "test" } as unknown as Env,
    db: {} as SqlDatabase,
    log: log as unknown as Logger & typeof log,
    correlation: { trace_id: "trace-1", request_id: "request-1" },
  };
}

describe("JOB_KINDS", () => {
  it("declares every kind with a retry policy a host can act on", () => {
    for (const [kind, definition] of Object.entries(JOB_KINDS)) {
      expect(definition.retry.maxAttempts, kind).toBeGreaterThanOrEqual(1);
      expect(definition.retry.retryDelayMs, kind).toBeGreaterThan(0);
    }
    expect(JOB_KINDS["image_build.finalize"].retry.retryDelayMs).toBe(
      IMAGE_BUILD_FINALIZATION_RETRY_DELAY_MS
    );
  });

  it("types a job as its kind's payload", () => {
    // Compile-time: a payload of the wrong kind is refused.
    const finalize: Job = { kind: "image_build.finalize", payload: FINALIZE_PAYLOAD };
    const autofix: Job = { kind: "github.autofix", payload: AUTOFIX_PAYLOAD };
    // @ts-expect-error -- an autofix envelope is not a finalization payload
    const crossed: Job = { kind: "image_build.finalize", payload: AUTOFIX_PAYLOAD };
    expect([finalize.kind, autofix.kind, crossed.kind]).toEqual([
      "image_build.finalize",
      "github.autofix",
      "image_build.finalize",
    ]);
  });
});

describe("deliverJob", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("hands a parsed payload to the kind's handler with the delivery and returns its outcome", async () => {
    const deps = fakeDeps();
    vi.mocked(handleImageBuildFinalization).mockResolvedValueOnce({
      retry: true,
      delayMs: 365_000,
    });

    const outcome = await deliverJob("image_build.finalize", FINALIZE_PAYLOAD, 3, deps);

    expect(outcome).toEqual({ retry: true, delayMs: 365_000 });
    expect(handleImageBuildFinalization).toHaveBeenCalledWith(
      FINALIZE_PAYLOAD,
      { attempts: 3, maxAttempts: JOB_KINDS["image_build.finalize"].retry.maxAttempts },
      deps
    );
    expect(handleAutofixJob).not.toHaveBeenCalled();
    expect(deps.log.error).not.toHaveBeenCalled();
  });

  it("routes each kind to its own handler", async () => {
    const deps = fakeDeps();
    vi.mocked(handleAutofixJob).mockResolvedValueOnce("ack");

    const outcome = await deliverJob("github.autofix", AUTOFIX_PAYLOAD, 1, deps);

    expect(outcome).toBe("ack");
    expect(handleAutofixJob).toHaveBeenCalledWith(
      AUTOFIX_PAYLOAD,
      { attempts: 1, maxAttempts: JOB_KINDS["github.autofix"].retry.maxAttempts },
      deps
    );
  });

  it("retries a payload that does not parse, without running the handler", async () => {
    const deps = fakeDeps();

    const outcome = await deliverJob(
      "image_build.finalize",
      { buildId: "build-2", callbackToken: "secret" },
      2,
      deps
    );

    expect(outcome).toEqual({ retry: true });
    expect(handleImageBuildFinalization).not.toHaveBeenCalled();
    expect(deps.log.error).toHaveBeenCalledWith(
      "job.payload_invalid",
      expect.objectContaining({
        job_kind: "image_build.finalize",
        attempts: 2,
        request_id: "request-1",
        issues: expect.any(Array),
      })
    );
  });

  it("retries when the handler throws, and logs the failure against the delivery", async () => {
    const deps = fakeDeps();
    const failure = new Error("provider unreachable");
    vi.mocked(handleImageBuildFinalization).mockRejectedValueOnce(failure);

    const outcome = await deliverJob("image_build.finalize", FINALIZE_PAYLOAD, 5, deps);

    expect(outcome).toEqual({ retry: true });
    expect(deps.log.error).toHaveBeenCalledWith(
      "job.handler_failed",
      expect.objectContaining({ job_kind: "image_build.finalize", attempts: 5, error: failure })
    );
  });

  it("parses with the kind's own schema: a valid payload of another kind is refused", async () => {
    const deps = fakeDeps();

    const outcome = await deliverJob("github.autofix", FINALIZE_PAYLOAD, 1, deps);

    expect(outcome).toEqual({ retry: true });
    expect(handleAutofixJob).not.toHaveBeenCalled();
  });

  it("continues the real batch adapter after a handler throws", async () => {
    const deps = fakeDeps();
    vi.mocked(handleImageBuildFinalization)
      .mockRejectedValueOnce(new Error("provider unreachable"))
      .mockResolvedValueOnce("ack");
    const messages = ["failed", "completed"].map((id) => ({
      id,
      timestamp: new Date(),
      attempts: 1,
      body: FINALIZE_PAYLOAD,
      ack: vi.fn(),
      retry: vi.fn(),
    }));
    const batch = {
      queue: "open-inspect-image-build-finalization-test",
      messages,
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } as unknown as MessageBatch<unknown>;

    await consumeJobBatch(batch, deps);

    expect(handleImageBuildFinalization).toHaveBeenCalledTimes(2);
    expect(messages[0]!.retry).toHaveBeenCalledOnce();
    expect(messages[0]!.ack).not.toHaveBeenCalled();
    expect(messages[1]!.ack).toHaveBeenCalledOnce();
    expect(messages[1]!.retry).not.toHaveBeenCalled();
  });

  it("covers every kind in the table", async () => {
    const deps = fakeDeps();
    vi.mocked(handleImageBuildFinalization).mockResolvedValue("ack");
    vi.mocked(handleAutofixJob).mockResolvedValue("ack");
    const payloads: Record<JobKind, unknown> = {
      "image_build.finalize": FINALIZE_PAYLOAD,
      "github.autofix": AUTOFIX_PAYLOAD,
    };

    for (const kind of Object.keys(JOB_KINDS) as JobKind[]) {
      expect(await deliverJob(kind, payloads[kind], 1, deps), kind).toBe("ack");
    }
  });
});
