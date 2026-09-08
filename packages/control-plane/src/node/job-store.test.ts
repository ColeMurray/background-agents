import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openJobStore, type ClaimedJob, type JobStore } from "./job-store";

const KINDS = ["image_build.finalize", "github.autofix"] as const;
const LEASE_MS = 60_000;

let dataDir: string;
let store: JobStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "oi-jobs-"));
  store = openJobStore(dataDir);
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function add(id: string, runAt: number, kind: string = KINDS[0]): void {
  store.add({ id, kind, payload: JSON.stringify({ id }), runAt }, 1_000);
}

function claim(now: number, limit = 10): ClaimedJob[] {
  return store.claim(now, limit, KINDS, now + LEASE_MS);
}

describe("openJobStore", () => {
  it("reports the soonest runnable job", () => {
    add("late", 5_000);
    add("soon", 2_000);

    expect(store.earliest(KINDS)).toBe(2_000);
    expect(
      claim(5_000)
        .map((job) => job.id)
        .sort()
    ).toEqual(["late", "soon"]);
  });

  it("leaves a kind it was not asked about out of the soonest runnable job", () => {
    add("mine", 5_000);
    add("theirs", 1_000, "session.completed");

    // Symmetric with claim: a kind this build cannot take must not be what
    // the poller schedules itself for.
    expect(store.earliest(KINDS)).toBe(5_000);
    expect(store.earliest([])).toBeNull();
  });

  it("takes the soonest jobs when it cannot take them all", () => {
    add("third", 7_000);
    add("first", 2_000);
    add("second", 5_000);

    expect(
      claim(9_000, 2)
        .map((job) => job.id)
        .sort()
    ).toEqual(["first", "second"]);
    expect(claim(9_000, 2).map((job) => job.id)).toEqual(["third"]);
  });

  it("leaves a job that is not yet runnable alone", () => {
    add("later", 9_000);

    expect(claim(8_999)).toEqual([]);
    expect(claim(9_000).map((job) => job.id)).toEqual(["later"]);
  });

  it("never claims a kind the caller does not know", () => {
    add("future-build", 1_000, "session.completed");

    expect(claim(9_000)).toEqual([]);
    // The row is untouched, so the build that understands it can still run it.
    expect(store.stats(9_000)).toMatchObject({ pending: 1, running: 0, dead: 0 });
    expect(store.claim(9_000, 10, ["session.completed"], 9_000 + LEASE_MS)).toHaveLength(1);
  });

  it("counts the attempt and does not hand the same job out twice", () => {
    add("once", 1_000);

    const [claimed] = claim(1_000);

    expect(claimed).toMatchObject({ kind: KINDS[0], attempts: 1 });
    expect(claimed!.token).toEqual(expect.any(String));
    expect(claim(1_000)).toEqual([]);
    expect(store.earliest(KINDS)).toBeNull();
  });

  it("removes a completed job and reschedules a retried one, keeping its attempts", () => {
    add("done", 1_000);
    add("again", 1_000);
    const claimed = claim(1_000);
    const tokenOf = (id: string): string => claimed.find((job) => job.id === id)!.token;

    store.complete("done", tokenOf("done"));
    store.retry("again", tokenOf("again"), 4_000);

    expect(store.earliest(KINDS)).toBe(4_000);
    expect(claim(4_000)).toEqual([expect.objectContaining({ id: "again", attempts: 2 })]);
  });

  it("keeps a buried job out of every later claim, with the error that ended it", () => {
    add("doomed", 1_000);
    const [claimed] = claim(1_000);

    store.bury("doomed", claimed!.token, "provider gone");

    expect(claim(9_000)).toEqual([]);
    expect(store.stats(1_000)).toMatchObject({ pending: 0, running: 0, dead: 1 });
  });

  describe("leases", () => {
    it("leaves a claim alone while its lease holds", () => {
      add("busy", 1_000);
      claim(1_000);

      expect(store.recoverExpiredClaims(1_000 + LEASE_MS - 1)).toEqual([]);
      expect(claim(1_000 + LEASE_MS - 1)).toEqual([]);
    });

    it("returns a claim whose lease ran out, and survives the restart", () => {
      add("interrupted", 1_000);
      claim(1_000);
      store.close();

      store = openJobStore(dataDir);
      expect(store.recoverExpiredClaims(1_000 + LEASE_MS)).toEqual(["interrupted"]);
      // The attempt the dead process spent is still spent.
      expect(claim(1_000 + LEASE_MS)).toEqual([
        expect.objectContaining({ id: "interrupted", attempts: 2 }),
      ]);
    });

    it("returns a claim no live delivery owns, without waiting out its lease", () => {
      add("interrupted", 1_000);
      claim(1_000);
      // The process that held the claim is gone; the store is reopened by
      // its replacement while the lease still has a quarter hour to run.
      store.close();
      store = openJobStore(dataDir);

      expect(store.recoverAllClaims()).toEqual(["interrupted"]);
      // The attempt the dead process spent is still spent: a queue counts a
      // delivery however it ended.
      expect(claim(1_100)).toEqual([expect.objectContaining({ id: "interrupted", attempts: 2 })]);
    });

    it("takes a claim back whatever its lease still has to run", () => {
      add("early", 1_000);
      add("later", 1_000);
      const held = claim(1_000);
      expect(held).toHaveLength(2);

      // One statement, one token, both rows: which is why the store cannot be
      // asked whose a claim is, and why this belongs to the boot alone.
      expect(store.recoverAllClaims().sort()).toEqual(["early", "later"]);
      expect(store.stats(9_000)).toMatchObject({ running: 0, pending: 2 });
      // The claims are gone, so the settlement that outlived them is refused.
      store.complete("early", held[0]!.token);
      expect(store.stats(9_000)).toMatchObject({ pending: 2 });
    });

    it("refuses a settlement from a delivery its lease already outlived", () => {
      add("overtaken", 1_000);
      const [stale] = claim(1_000);
      store.recoverExpiredClaims(1_000 + LEASE_MS);
      const [fresh] = claim(1_000 + LEASE_MS);

      // The delivery that lost its lease comes back and tries to finish.
      store.complete("overtaken", stale!.token);

      expect(store.stats(9_000)).toMatchObject({ running: 1 });
      store.complete("overtaken", fresh!.token);
      expect(store.stats(9_000)).toMatchObject({ pending: 0, running: 0, dead: 0 });
    });

    it("refuses a stale retry and a stale bury as well", () => {
      add("overtaken", 1_000);
      const [stale] = claim(1_000);
      store.recoverExpiredClaims(1_000 + LEASE_MS);
      claim(1_000 + LEASE_MS);

      store.retry("overtaken", stale!.token, 99_000);
      store.bury("overtaken", stale!.token, "not yours to end");

      expect(store.stats(9_000)).toMatchObject({ running: 1, dead: 0 });
    });
  });

  describe("stats", () => {
    it("reports rows by status and how overdue the most overdue runnable job is", () => {
      add("waiting", 1_000);
      add("busy", 1_000);
      claim(1_000, 1);

      expect(store.stats(3_500)).toEqual({
        pending: 1,
        running: 1,
        dead: 0,
        oldestRunnableLagMs: 2_500,
      });
    });

    it("does not count a job deliberately delayed into the future as late", () => {
      add("backing-off", 50_000);

      expect(store.stats(10_000)).toMatchObject({ pending: 1, oldestRunnableLagMs: null });
      expect(store.stats(50_000)).toMatchObject({ oldestRunnableLagMs: 0 });
    });

    it("reports no lag when nothing is pending", () => {
      expect(store.stats(5_000)).toEqual({
        pending: 0,
        running: 0,
        dead: 0,
        oldestRunnableLagMs: null,
      });
    });
  });
});
