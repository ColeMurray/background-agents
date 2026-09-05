import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlDatabase } from "../db/sql-database";
import type * as JobsModule from "../jobs";
import { JOB_KINDS, deliverJob, type JobKind } from "../jobs";
import type { Logger } from "../logger";
import type { Env } from "../types";
import {
  JOB_QUEUE_BINDINGS,
  JOB_QUEUE_PREFIXES,
  consumeJobBatch,
  createQueueJobs,
  jobKindForQueue,
} from "./job-queue";

// Delivery itself is `deliverJob`'s to test (jobs.test.ts); here only the
// Queue mechanics around it are exercised.
vi.mock("../jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof JobsModule>()),
  deliverJob: vi.fn(),
}));

const TERRAFORM_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../terraform/environments/production"
);
const CONTROL_PLANE_WORKER = "module.control_plane_worker.worker_name";

interface TerraformConsumer {
  queuePrefix: string;
  bindingName: string | undefined;
  maxRetries: number;
  retryDelay: number;
}

/** Every `cloudflare_queue_consumer` Terraform points at the control-plane Worker, by queue prefix. */
function terraformControlPlaneConsumers(): TerraformConsumer[] {
  const source = readdirSync(TERRAFORM_DIR)
    .filter((name) => name.endsWith(".tf"))
    .map((name) => readFileSync(join(TERRAFORM_DIR, name), "utf8"))
    .join("\n");
  const queuePrefixes = new Map(
    [
      ...source.matchAll(
        /resource "cloudflare_queue" "(\w+)" \{[^}]*queue_name\s*=\s*"([^"$]+)-\$\{local\.name_suffix\}"/g
      ),
    ].map((match) => [match[1]!, match[2]!])
  );
  const bindings = new Map(
    [
      ...source.matchAll(
        /binding_name\s*=\s*"(\w+)"\s*\n\s*queue_name\s*=\s*cloudflare_queue\.(\w+)(?:\[0\])?\.queue_name/g
      ),
    ].map((match) => [match[2]!, match[1]!])
  );
  const consumers: TerraformConsumer[] = [];
  for (const block of source.matchAll(
    /resource "cloudflare_queue_consumer" "\w+" \{([\s\S]*?)\n\}/g
  )) {
    const body = block[1]!;
    if (!body.includes(`script_name       = ${CONTROL_PLANE_WORKER}`)) continue;
    const queue = /queue_id\s*=\s*cloudflare_queue\.(\w+)/.exec(body)?.[1];
    const maxRetries = /max_retries\s*=\s*(\d+)/.exec(body)?.[1];
    const retryDelay = /retry_delay\s*=\s*(\d+)/.exec(body)?.[1];
    const queuePrefix = queue && queuePrefixes.get(queue);
    if (!queuePrefix || !maxRetries || !retryDelay) {
      throw new Error(`Unparsed cloudflare_queue_consumer block:\n${body}`);
    }
    consumers.push({
      queuePrefix,
      bindingName: bindings.get(queue),
      maxRetries: Number(maxRetries),
      retryDelay: Number(retryDelay),
    });
  }
  return consumers;
}

function message(id: string, body: unknown, attempts = 1) {
  return { id, timestamp: new Date(), body, attempts, ack: vi.fn(), retry: vi.fn() };
}

function batch(queue: string, ...messages: ReturnType<typeof message>[]) {
  return {
    queue,
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown> & { retryAll: ReturnType<typeof vi.fn> };
}

function fakeHost() {
  return {
    env: { LOG_LEVEL: "error" } as unknown as Env,
    db: {} as SqlDatabase,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
  };
}

const FINALIZE_PAYLOAD = {
  version: 1 as const,
  buildId: "build-1",
  completionHash: "a".repeat(64),
};

describe("jobKindForQueue", () => {
  it("recovers the kind from the queue prefix Terraform names it with", () => {
    expect(jobKindForQueue("open-inspect-image-build-finalization-prod")).toBe(
      "image_build.finalize"
    );
    expect(jobKindForQueue("open-inspect-github-autofix-prod")).toBe("github.autofix");
  });

  it("matches the prefix as a whole word: a deployment named after another kind does not misroute", () => {
    expect(jobKindForQueue("open-inspect-image-build-finalization-github-autofix-test")).toBe(
      "image_build.finalize"
    );
    expect(jobKindForQueue("open-inspect-github-autofix")).toBeUndefined();
    expect(jobKindForQueue("open-inspect-slack-completion-prod")).toBeUndefined();
  });
});

describe("Terraform parity", () => {
  it("declares one consumer per job kind on the control-plane Worker, with the kind's retry policy", () => {
    const consumers = terraformControlPlaneConsumers();
    const kinds = Object.keys(JOB_KINDS) as JobKind[];

    expect(consumers.map((consumer) => consumer.queuePrefix).sort()).toEqual(
      kinds.map((kind) => JOB_QUEUE_PREFIXES[kind]).sort()
    );
    for (const consumer of consumers) {
      const kind = jobKindForQueue(`${consumer.queuePrefix}-prod`);
      expect(kind, consumer.queuePrefix).toBeDefined();
      const { retry } = JOB_KINDS[kind!];
      // Cloudflare counts retries after the first delivery; the table counts deliveries.
      expect(consumer.maxRetries, `${kind} max_retries`).toBe(retry.maxAttempts - 1);
      expect(consumer.retryDelay, `${kind} retry_delay`).toBe(retry.retryDelaySeconds);
      expect(consumer.bindingName, `${kind} producer binding`).toBe(JOB_QUEUE_BINDINGS[kind!]);
    }
  });
});

describe("createQueueJobs", () => {
  it("sends the payload alone to the kind's queue", async () => {
    const finalization = { send: vi.fn(async () => undefined) };
    const autofix = { send: vi.fn(async () => undefined) };
    const jobs = createQueueJobs({
      IMAGE_BUILD_FINALIZATION_QUEUE: finalization as unknown as Queue<unknown>,
      AUTOFIX_QUEUE: autofix as unknown as Queue<unknown>,
    });

    await jobs.send({ kind: "image_build.finalize", payload: FINALIZE_PAYLOAD });

    expect(finalization.send).toHaveBeenCalledWith(FINALIZE_PAYLOAD);
    expect(autofix.send).not.toHaveBeenCalled();
  });

  it("rejects a kind whose queue this deployment does not bind", async () => {
    const jobs = createQueueJobs({
      IMAGE_BUILD_FINALIZATION_QUEUE: { send: vi.fn() } as unknown as Queue<unknown>,
    });

    await expect(
      jobs.send({
        kind: "github.autofix",
        payload: {
          version: 1,
          eventType: "issue_comment",
          action: "created",
          deliveryId: "d",
          providerObject: { kind: "pr_comment", id: "1" },
          repository: { id: "1", owner: "acme", name: "widgets" },
          pullRequestNumber: 1,
          receivedAt: "2026-07-30T05:00:00.000Z",
        },
      })
    ).rejects.toThrow(/github\.autofix/);
  });

  it("surfaces the queue's failure so the producer keeps its row recoverable", async () => {
    const jobs = createQueueJobs({
      IMAGE_BUILD_FINALIZATION_QUEUE: {
        send: vi.fn(async () => {
          throw new Error("queue unavailable");
        }),
      } as unknown as Queue<unknown>,
    });

    await expect(
      jobs.send({ kind: "image_build.finalize", payload: FINALIZE_PAYLOAD })
    ).rejects.toThrow("queue unavailable");
  });
});

describe("consumeJobBatch", () => {
  beforeEach(() => {
    vi.mocked(deliverJob).mockReset();
  });

  it("delivers each message to its queue's kind, with the message as the correlation, and acks", async () => {
    const host = fakeHost();
    vi.mocked(deliverJob).mockResolvedValue("ack");
    const first = message("message-1", FINALIZE_PAYLOAD, 1);
    const second = message("message-2", FINALIZE_PAYLOAD, 4);

    await consumeJobBatch(batch("open-inspect-image-build-finalization-prod", first, second), host);

    expect(deliverJob).toHaveBeenNthCalledWith(1, "image_build.finalize", FINALIZE_PAYLOAD, 1, {
      ...host,
      correlation: { trace_id: "message-1", request_id: "message-1" },
    });
    expect(deliverJob).toHaveBeenNthCalledWith(2, "image_build.finalize", FINALIZE_PAYLOAD, 4, {
      ...host,
      correlation: { trace_id: "message-2", request_id: "message-2" },
    });
    expect(first.ack).toHaveBeenCalledOnce();
    expect(second.ack).toHaveBeenCalledOnce();
    expect(first.retry).not.toHaveBeenCalled();
  });

  it("maps a retry onto the message: the handler's delay when named, the queue's own otherwise", async () => {
    const host = fakeHost();
    vi.mocked(deliverJob)
      .mockResolvedValueOnce({ retry: true, delaySeconds: 365 })
      .mockResolvedValueOnce({ retry: true });
    const delayed = message("message-1", FINALIZE_PAYLOAD);
    const bare = message("message-2", FINALIZE_PAYLOAD);

    await consumeJobBatch(batch("open-inspect-image-build-finalization-prod", delayed, bare), host);

    expect(delayed.retry).toHaveBeenCalledWith({ delaySeconds: 365 });
    expect(bare.retry).toHaveBeenCalledWith();
    expect(delayed.ack).not.toHaveBeenCalled();
    expect(bare.ack).not.toHaveBeenCalled();
  });

  it("keeps delivering after one message's outcome: a batch is never aborted midway", async () => {
    const host = fakeHost();
    vi.mocked(deliverJob).mockResolvedValueOnce({ retry: true }).mockResolvedValueOnce("ack");
    const retried = message("message-1", FINALIZE_PAYLOAD);
    const acked = message("message-2", FINALIZE_PAYLOAD);

    await consumeJobBatch(batch("open-inspect-github-autofix-prod", retried, acked), host);

    expect(deliverJob).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deliverJob).mock.calls[0]![0]).toBe("github.autofix");
    expect(retried.retry).toHaveBeenCalledOnce();
    expect(acked.ack).toHaveBeenCalledOnce();
  });

  it("retries a whole batch from a queue no kind owns, so it dead-letters rather than vanishes", async () => {
    const host = fakeHost();
    const stray = message("message-1", FINALIZE_PAYLOAD);
    const unknown = batch("open-inspect-slack-completion-prod", stray);

    await consumeJobBatch(unknown, host);

    expect(deliverJob).not.toHaveBeenCalled();
    expect(unknown.retryAll).toHaveBeenCalledOnce();
    expect(stray.ack).not.toHaveBeenCalled();
    expect(host.log.error).toHaveBeenCalledWith(
      "job.queue_unknown",
      expect.objectContaining({ queue: "open-inspect-slack-completion-prod", messages: 1 })
    );
  });
});
