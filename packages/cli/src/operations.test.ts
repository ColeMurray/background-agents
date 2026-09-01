import type {
  ExternalEvent,
  ExternalEventChange,
} from "@open-inspect/shared/types/external-session-api";
import { describe, expect, it, vi } from "vitest";
import { CliError } from "./errors.js";
import { Operations } from "./operations.js";

function event(id: string, createdAt: number, text = id): ExternalEvent {
  return {
    id,
    type: "token",
    messageId: null,
    createdAt,
    data: { text },
  };
}

function upsert(revision: number, value: ExternalEvent): ExternalEventChange {
  return { kind: "upsert", revision, event: value };
}

function remove(revision: number, eventId: string): ExternalEventChange {
  return { kind: "delete", revision, eventId };
}

describe("Operations", () => {
  it("preserves caller-supplied idempotency and client request IDs", async () => {
    const api = {
      createSession: vi.fn((input: unknown) => Promise.resolve(input)),
      promptSession: vi.fn((_id: string, input: unknown) => Promise.resolve(input)),
    };
    const operations = new Operations(api as never);

    await operations.createSession({
      title: "T",
      model: "openai/gpt-5.6-sol",
      reasoningEffort: "high",
      idempotencyKey: "caller-create",
    });
    await operations.promptSession("s1", { content: "P", clientRequestId: "caller-prompt" });

    expect(api.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "caller-create" })
    );
    expect(api.promptSession).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ clientRequestId: "caller-prompt" })
    );
  });

  it("passes session list pagination through unchanged", async () => {
    const api = { listSessions: vi.fn().mockResolvedValue({ sessions: [], hasMore: false }) };
    const operations = new Operations(api as never);

    await operations.listSessions({ limit: 40, offset: 80 });

    expect(api.listSessions).toHaveBeenCalledWith({ limit: 40, offset: 80 });
  });

  it("preserves snapshot order and resumes strict journal changes with tombstones and rename", async () => {
    const initial = [
      upsert(2, event("event-1", 1)),
      upsert(3, event("event-2", 2)),
      upsert(1, event("event-3", 3)),
    ];
    const incremental = [
      upsert(4, event("event-1", 1, "updated older event")),
      upsert(5, event("event-4", 4)),
      remove(6, "event-3"),
      upsert(7, event("event-1", 1, "second update")),
      remove(8, "event-4"),
      upsert(9, event("event-4-renamed", 4)),
    ];
    const api = {
      events: vi
        .fn()
        .mockResolvedValueOnce({
          changes: initial.slice(0, 2),
          checkpoint: 3,
          cursor: "initial:2",
          hasMore: true,
        })
        .mockResolvedValueOnce({ changes: initial.slice(2), checkpoint: 3, hasMore: false })
        .mockResolvedValueOnce({
          changes: incremental.slice(0, 2),
          checkpoint: 9,
          cursor: "delta:2",
          hasMore: true,
        })
        .mockRejectedValueOnce(new CliError("transport", "connection reset"))
        .mockResolvedValueOnce({
          changes: incremental.slice(0, 2),
          checkpoint: 9,
          cursor: "delta:2-retry",
          hasMore: true,
        })
        .mockResolvedValueOnce({ changes: incremental.slice(2), checkpoint: 9, hasMore: false }),
    };
    const sleep = vi.fn(() => Promise.resolve());
    const operations = new Operations(api as never, { sleep });
    const controller = new AbortController();
    const seen: ExternalEventChange[] = [];

    for await (const change of operations.followEvents("s1", {
      pollIntervalMs: 250,
      timeoutMs: 5_000,
      signal: controller.signal,
    })) {
      seen.push(change);
      if (seen.length === initial.length + incremental.length) controller.abort();
    }

    expect(seen).toEqual([...initial, ...incremental]);
    expect(seen.map(({ revision }) => revision)).toEqual([2, 3, 1, 4, 5, 6, 7, 8, 9]);
    expect(
      seen
        .slice(initial.length)
        .every((change, index, changes) =>
          index === 0 ? change.revision > 3 : change.revision > changes[index - 1]!.revision
        )
    ).toBe(true);
    expect(seen.slice(-2)).toEqual([remove(8, "event-4"), upsert(9, event("event-4-renamed", 4))]);
    expect(api.events.mock.calls.map((call) => call[1])).toEqual([
      { after: undefined, signal: controller.signal },
      { cursor: "initial:2", signal: controller.signal },
      { after: 3, signal: controller.signal },
      { cursor: "delta:2", signal: controller.signal },
      { after: 3, signal: controller.signal },
      { cursor: "delta:2-retry", signal: controller.signal },
    ]);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("retries from the prior checkpoint when pages disagree or revisions regress", async () => {
    const change = upsert(6, event("event-1", 1));
    const api = {
      events: vi
        .fn()
        .mockResolvedValueOnce({ changes: [], checkpoint: 5, hasMore: false })
        .mockResolvedValueOnce({ changes: [change], checkpoint: 7, cursor: "next", hasMore: true })
        .mockResolvedValueOnce({ changes: [remove(7, "event-2")], checkpoint: 8, hasMore: false })
        .mockResolvedValueOnce({ changes: [change], checkpoint: 7, cursor: "retry", hasMore: true })
        .mockResolvedValueOnce({ changes: [remove(6, "event-2")], checkpoint: 7, hasMore: false })
        .mockResolvedValueOnce({
          changes: [change, remove(7, "event-2")],
          checkpoint: 7,
          hasMore: false,
        }),
    };
    const controller = new AbortController();
    const operations = new Operations(api as never, { sleep: () => Promise.resolve() });
    const iterator = operations.followEvents("s1", { signal: controller.signal });

    await expect(iterator.next()).resolves.toMatchObject({ value: change });
    controller.abort();
    await iterator.return(undefined);
    expect(api.events.mock.calls.slice(1).map((call) => call[1]?.after)).toEqual([
      5,
      undefined,
      5,
      undefined,
      5,
    ]);
  });

  it("deduplicates replayed event IDs unless their revision is greater", async () => {
    const first = upsert(5, event("event-1", 1, "new"));
    const api = {
      events: vi
        .fn()
        .mockResolvedValueOnce({ changes: [first], checkpoint: 5, hasMore: false })
        .mockRejectedValueOnce(new CliError("expired", "checkpoint expired"))
        .mockResolvedValueOnce({
          changes: [upsert(4, event("event-1", 1, "old")), upsert(6, event("event-1", 1, "newer"))],
          checkpoint: 6,
          hasMore: false,
        }),
    };
    const controller = new AbortController();
    const seen: ExternalEventChange[] = [];
    const operations = new Operations(api as never, { sleep: () => Promise.resolve() });

    for await (const change of operations.followEvents("s1", { signal: controller.signal })) {
      seen.push(change);
      if (seen.length === 2) controller.abort();
    }

    expect(seen).toEqual([first, upsert(6, event("event-1", 1, "newer"))]);
    expect(api.events.mock.calls.map((call) => call[1]?.after)).toEqual([undefined, 5, undefined]);
  });

  it("waits until settled", async () => {
    const api = {
      waitStatus: vi
        .fn()
        .mockResolvedValueOnce({ sessionId: "s1", status: "running", settled: false })
        .mockResolvedValueOnce({ sessionId: "s1", status: "completed", settled: true }),
    };
    const operations = new Operations(api as never, { sleep: () => Promise.resolve() });
    await expect(
      operations.wait("s1", { pollIntervalMs: 1, timeoutMs: 100 })
    ).resolves.toMatchObject({ settled: true });
  });

  it("caps polling sleeps and returns the latest observed status on timeout", async () => {
    let now = 0;
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });
    const waitStatus = vi.fn().mockResolvedValue({
      sessionId: "s1",
      status: "running",
      settled: false,
      latestAssistantMessage: { id: "m1", content: "working", completedAt: null },
    });
    const operations = new Operations({ waitStatus } as never, { now: () => now, sleep });

    await expect(operations.wait("s1", { pollIntervalMs: 1_000, timeoutMs: 75 })).resolves.toEqual({
      sessionId: "s1",
      status: "running",
      settled: false,
      timedOut: true,
      latestAssistantMessage: { id: "m1", content: "working", completedAt: null },
    });
    expect(sleep).toHaveBeenCalledWith(75, undefined);
    expect(waitStatus).toHaveBeenCalledTimes(1);
  });

  it("cancels a hanging status fetch at the deadline without a final fetch", async () => {
    vi.useFakeTimers();
    try {
      const waitStatus = vi
        .fn()
        .mockResolvedValueOnce({ sessionId: "s1", status: "running", settled: false })
        .mockImplementationOnce(
          (_id: string, signal: AbortSignal) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            })
        );
      const operations = new Operations({ waitStatus } as never);

      const waiting = operations.wait("s1", { pollIntervalMs: 100, timeoutMs: 250 });
      await vi.advanceTimersByTimeAsync(250);

      await expect(waiting).resolves.toEqual({
        sessionId: "s1",
        status: "running",
        settled: false,
        timedOut: true,
      });
      expect(waitStatus).toHaveBeenCalledTimes(2);
      expect(waitStatus.mock.calls[1]?.[1].aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a hanging initial fetch when no status was observed", async () => {
    vi.useFakeTimers();
    try {
      const waitStatus = vi.fn(
        (_id: string, signal: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          })
      );
      const waiting = new Operations({ waitStatus } as never).wait("s1", { timeoutMs: 50 });
      const assertion = expect(waiting).rejects.toMatchObject({ kind: "timeout" });

      await vi.advanceTimersByTimeAsync(50);

      await assertion;
      expect(waitStatus).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves caller abort reasons during a deferred status fetch", async () => {
    const controller = new AbortController();
    const reason = new Error("caller stopped waiting");
    const waitStatus = vi.fn(
      (_id: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        })
    );
    const waiting = new Operations({ waitStatus } as never).wait("s1", {
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    controller.abort(reason);

    await expect(waiting).rejects.toBe(reason);
  });

  it("treats a zero timeout as immediate and does not start a status fetch", async () => {
    const waitStatus = vi.fn();
    const operations = new Operations({ waitStatus } as never);

    await expect(operations.wait("s1", { timeoutMs: 0 })).rejects.toMatchObject({
      kind: "timeout",
    });
    expect(waitStatus).not.toHaveBeenCalled();
  });
});
