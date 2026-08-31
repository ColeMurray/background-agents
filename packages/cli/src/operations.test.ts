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

  it("waits until settled and enforces timeout", async () => {
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

    const stuck = new Operations(
      { waitStatus: vi.fn().mockResolvedValue({ settled: false }) } as never,
      { now: vi.fn().mockReturnValueOnce(0).mockReturnValue(101), sleep: () => Promise.resolve() }
    );
    await expect(stuck.wait("s1", { pollIntervalMs: 1, timeoutMs: 100 })).rejects.toThrow(
      "timed out"
    );
  });
});
