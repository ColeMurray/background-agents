import { describe, expect, it, vi } from "vitest";
import {
  AbandonedDraftSweep,
  SessionDraftExpiryClient,
  type AbandonedDraftIndex,
  type DraftExpiryClient,
  type DraftSweepOutcome,
} from "./abandoned-draft-sweep";
import type { Logger } from "../logger";
import { SessionInternalPaths } from "./contracts";
import type { SessionRuntimeClient } from "./runtime-client";

const NOW = 1_000_000_000;
const TTL_MS = 8 * 60 * 60 * 1000;

function createLog(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function createIndex(ids: string[] | Error, archiveError?: Error): AbandonedDraftIndex {
  return {
    listAbandonedDraftSessionIds: vi.fn(async () => {
      if (ids instanceof Error) throw ids;
      return ids;
    }),
    archiveOrphanedDraft: vi.fn(async () => {
      if (archiveError) throw archiveError;
      return true;
    }),
  };
}

function createClient(outcomes: Record<string, DraftSweepOutcome | Error> = {}): DraftExpiryClient {
  return {
    expireDraft: vi.fn(async (sessionId: string) => {
      const outcome = outcomes[sessionId] ?? "archived";
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }),
  };
}

describe("AbandonedDraftSweep", () => {
  it("queries candidates against the ttl cutoff", async () => {
    const index = createIndex([]);
    const sweep = new AbandonedDraftSweep(index, createClient(), createLog(), TTL_MS, 50);

    await sweep.run(NOW);

    expect(index.listAbandonedDraftSessionIds).toHaveBeenCalledWith(NOW - TTL_MS, 50);
  });

  it("archives every candidate the session confirms", async () => {
    const sweep = new AbandonedDraftSweep(
      createIndex(["a", "b"]),
      createClient(),
      createLog(),
      TTL_MS,
      50
    );

    const result = await sweep.run(NOW);

    expect(result).toEqual({
      candidates: 2,
      archived: 2,
      notDraft: 0,
      hasWork: 0,
      missing: 0,
      errored: 0,
      truncated: false,
    });
  });

  it("separates the two reasons a session declines to expire", async () => {
    const sweep = new AbandonedDraftSweep(
      createIndex(["archived-one", "started-work", "queued-work"]),
      createClient({ "started-work": "not_draft", "queued-work": "has_work" }),
      createLog(),
      TTL_MS,
      50
    );

    const result = await sweep.run(NOW);

    // The split is the whole point: `not_draft` means a stale index that has now
    // been repaired, `has_work` means a prompt that never dispatched.
    expect(result).toMatchObject({
      candidates: 3,
      archived: 1,
      notDraft: 1,
      hasWork: 1,
      errored: 0,
    });
  });

  it("isolates a failing session from the rest of the batch", async () => {
    const log = createLog();
    const sweep = new AbandonedDraftSweep(
      createIndex(["healthy", "broken"]),
      createClient({ broken: new Error("unreachable") }),
      log,
      TTL_MS,
      50
    );

    const result = await sweep.run(NOW);

    expect(result).toMatchObject({ candidates: 2, archived: 1, errored: 1 });
    expect(log.warn).toHaveBeenCalledWith(
      "Abandoned draft expiry failed",
      expect.objectContaining({ session_id: "broken" })
    );
  });

  it("reports truncation when the batch fills, so a backlog is visible", async () => {
    const sweep = new AbandonedDraftSweep(
      createIndex(["a", "b"]),
      createClient(),
      createLog(),
      TTL_MS,
      2
    );

    const result = await sweep.run(NOW);

    expect(result.truncated).toBe(true);
  });

  it("gives up the sweep without touching sessions when the query fails", async () => {
    const log = createLog();
    const client = createClient();
    const sweep = new AbandonedDraftSweep(
      createIndex(new Error("d1 unavailable")),
      client,
      log,
      TTL_MS,
      50
    );

    const result = await sweep.run(NOW);

    expect(result).toEqual({
      candidates: 0,
      archived: 0,
      notDraft: 0,
      hasWork: 0,
      missing: 0,
      errored: 0,
      truncated: false,
    });
    expect(client.expireDraft).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });

  // The sweep reads its batch oldest-first, so a row that declines without
  // changing state is selected again on every run and nothing behind it is ever
  // reached. These cover the two outcomes that used to leave a row untouched.
  it("archives the index row itself when the durable object holds no session", async () => {
    const index = createIndex(["orphan"]);
    const sweep = new AbandonedDraftSweep(
      index,
      createClient({ orphan: "missing" }),
      createLog(),
      TTL_MS,
      50
    );

    const result = await sweep.run(NOW);

    // A 404 proves there is no durable object state to diverge from, so the
    // index row can be retired directly.
    expect(index.archiveOrphanedDraft).toHaveBeenCalledWith("orphan");
    expect(result).toMatchObject({ candidates: 1, missing: 1, archived: 0, errored: 0 });
  });

  it("counts a failed orphan archive as errored without dropping the batch", async () => {
    const index = createIndex(["orphan", "healthy"], new Error("d1 write failed"));
    const sweep = new AbandonedDraftSweep(
      index,
      createClient({ orphan: "missing" }),
      createLog(),
      TTL_MS,
      50
    );

    const result = await sweep.run(NOW);

    expect(result).toMatchObject({ candidates: 2, archived: 1, missing: 0, errored: 1 });
  });

  it("raises an alarm when a full batch makes no progress at all", async () => {
    // The signature of a wall: every candidate declined, so the next run reads
    // exactly the same rows. This is the alert that was missing when the sweep
    // spun for a day logging `truncated:true` at info.
    const log = createLog();
    const sweep = new AbandonedDraftSweep(
      createIndex(["a", "b"]),
      createClient({ a: new Error("unreachable"), b: new Error("unreachable") }),
      log,
      TTL_MS,
      2
    );

    const result = await sweep.run(NOW);

    expect(result).toMatchObject({ truncated: true, errored: 2 });
    expect(log.error).toHaveBeenCalledWith(
      "Abandoned draft sweep made no progress",
      expect.objectContaining({ event: "scheduler.abandoned_draft_sweep_stalled" })
    );
  });

  it("stays quiet when a full batch was repaired rather than archived", async () => {
    // `not_draft` and `has_work` archive nothing, but both now leave `created`
    // behind, so the next run reads different rows. That is progress, not a wall.
    const log = createLog();
    const sweep = new AbandonedDraftSweep(
      createIndex(["a", "b"]),
      createClient({ a: "not_draft", b: "has_work" }),
      log,
      TTL_MS,
      2
    );

    const result = await sweep.run(NOW);

    expect(result).toMatchObject({ truncated: true, archived: 0, notDraft: 1, hasWork: 1 });
    expect(log.error).not.toHaveBeenCalled();
  });

  it("stays quiet when a partial batch fails, since nothing is being starved", async () => {
    const log = createLog();
    const sweep = new AbandonedDraftSweep(
      createIndex(["a"]),
      createClient({ a: new Error("unreachable") }),
      log,
      TTL_MS,
      50
    );

    const result = await sweep.run(NOW);

    expect(result).toMatchObject({ truncated: false, errored: 1 });
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe("SessionDraftExpiryClient", () => {
  const fetches: Array<{ sessionId: string; path: string; init?: RequestInit }> = [];

  function createSessions(response: Response): SessionRuntimeClient {
    fetches.length = 0;
    return {
      fetch: vi.fn(async (sessionId: string, path: string, init?: RequestInit) => {
        fetches.push({ sessionId, path, init });
        return response;
      }),
    };
  }

  it("bounds each request so one stalled session cannot hold up the sweep", async () => {
    const client = new SessionDraftExpiryClient(
      createSessions(Response.json({ outcome: "archived" }))
    );

    await client.expireDraft("session-1");

    expect(fetches[0]).toMatchObject({
      sessionId: "session-1",
      path: SessionInternalPaths.expireDraft,
      init: { method: "POST", signal: expect.any(AbortSignal) },
    });
  });

  it("returns the outcome the session reported", async () => {
    const client = new SessionDraftExpiryClient(
      createSessions(Response.json({ outcome: "has_work", status: "created" }))
    );

    await expect(client.expireDraft("session-1")).resolves.toBe("has_work");
  });

  it("rejects an outcome outside the documented contract", async () => {
    const client = new SessionDraftExpiryClient(
      createSessions(Response.json({ outcome: "deleted" }))
    );

    await expect(client.expireDraft("session-1")).rejects.toThrow(/unrecognized outcome/);
  });

  it("rejects a non-ok response", async () => {
    const client = new SessionDraftExpiryClient(
      createSessions(new Response("nope", { status: 500 }))
    );

    await expect(client.expireDraft("session-1")).rejects.toThrow(/status 500/);
  });

  it("reports a missing session rather than throwing, so the sweep can retire it", async () => {
    // 404 is a definitive answer, not a transient failure: the durable object
    // has no session at all. Throwing made it indistinguishable from an outage,
    // and the row was left to be re-read on every subsequent sweep.
    const client = new SessionDraftExpiryClient(
      createSessions(Response.json({ error: "Session not found" }, { status: 404 }))
    );

    await expect(client.expireDraft("session-1")).resolves.toBe("missing");
  });
});
