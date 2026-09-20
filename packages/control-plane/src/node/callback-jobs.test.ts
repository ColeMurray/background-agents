import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { verifyCallbackSignature } from "@open-inspect/shared/auth";
import { COMPLETION_JOB, SLACK_CONTEXT } from "../../test/callback-fixtures";
import { createLogger } from "../logger";
import type { JobDeps } from "../jobs";
import type { FetchClient } from "../platform-ports";
import type { Env } from "../types";
import { NodeJobs } from "./job-queue";
import { openJobStore } from "./job-store";

it("delivers an accepted callback after reopening the Node jobs database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oi-callback-jobs-"));
  let store = openJobStore(dir);
  const log = createLogger("test", {}, "error");
  const fetch = vi.fn<FetchClient["fetch"]>().mockImplementation(async () => new Response(null));
  const deps = () => ({
    env: { SLACK_BOT: { fetch }, SERVICE_AUTH_SECRET_SLACK_BOT: "key" } as unknown as Env,
    db: {} as JobDeps["db"],
    log,
  });
  let queue = new NodeJobs({ store, deps, log });
  try {
    await queue.send({ kind: "session.callback", payload: COMPLETION_JOB });
    expect(fetch).not.toHaveBeenCalled();
    store.close();
    store = openJobStore(dir);
    queue = new NodeJobs({ store, deps, log });
    queue.start();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await queue.drain();
    expect(queue.stats()).toMatchObject({ pending: 0, running: 0, dead: 0 });
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(body.timestamp).toBe(COMPLETION_JOB.payload.timestamp);
    expect(await verifyCallbackSignature(body, "key")).toBe(true);
  } finally {
    queue.stop();
    await queue.drain();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("retries terminal failures but retires cosmetic failures in the real Node poller", async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), "oi-callback-retry-"));
  const store = openJobStore(dir);
  const log = createLogger("test", {}, "error");
  const fetch = vi
    .fn<FetchClient["fetch"]>()
    .mockImplementation(async () => new Response(null, { status: 503 }));
  const queue = new NodeJobs({
    store,
    log,
    deps: () => ({
      env: { SLACK_BOT: { fetch }, SERVICE_AUTH_SECRET_SLACK_BOT: "key" } as unknown as Env,
      db: {} as JobDeps["db"],
      log,
    }),
  });
  try {
    await queue.send({ kind: "session.callback", payload: COMPLETION_JOB });
    await queue.send({
      kind: "session.callback",
      payload: {
        version: 1,
        type: "slack.tool_call",
        payload: {
          sessionId: "session-1",
          timestamp: Date.now(),
          tool: "bash",
          args: {},
          callId: "call-1",
          context: SLACK_CONTEXT,
        },
      },
    });
    queue.start();
    await vi.advanceTimersByTimeAsync(1);
    await queue.drain();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(queue.stats()).toMatchObject({ pending: 1, running: 0 });
    fetch.mockImplementation(async () => new Response(null));
    await vi.advanceTimersByTimeAsync(15_000);
    await queue.drain();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(queue.stats()).toMatchObject({ pending: 0, running: 0, dead: 0 });
  } finally {
    queue.stop();
    await queue.drain();
    store.close();
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  }
});
