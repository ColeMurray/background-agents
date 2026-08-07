import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SessionDO } from "../../src/session/durable-object";
import { SessionAttachmentRepository } from "../../src/session/session-attachment-repository";
import { SessionRepository } from "../../src/session/repository";
import { initSession } from "./helpers";

function repositoryFor(instance: SessionDO): SessionRepository {
  return new SessionRepository(
    instance.ctx.storage.sql,
    (closure) => instance.ctx.storage.transactionSync(closure),
    new SessionAttachmentRepository(instance.ctx.storage.sql)
  );
}

describe("session view delta storage", () => {
  it("atomically commits projection changes with increasing revisions", async () => {
    const { stub } = await initSession({ sessionName: "view-delta-commit" });

    await runInDurableObject(stub, (instance: SessionDO) => {
      const repository = repositoryFor(instance);
      const session = repository.getSession();
      expect(session).not.toBeNull();
      expect(repository.getCurrentViewRevision()).toBe(0);

      const firstRevision = repository.updateSessionTitleWithViewDelta(session!.id, "First", 1_000);
      const secondRevision = repository.updateSessionTitleWithViewDelta(
        session!.id,
        "Second",
        2_000
      );

      expect([firstRevision, secondRevision]).toEqual([1, 2]);
      expect(repository.getSession()?.title).toBe("Second");
      expect(repository.readContiguousSessionViewDeltas(0, 2)?.map((row) => row.revision)).toEqual([
        1, 2,
      ]);
      expect(repository.readContiguousSessionViewDeltas(2, 2)).toEqual([]);
    });
  });

  it("rolls back projection changes and detects an incomplete retained range", async () => {
    const { stub } = await initSession({
      sessionName: "view-delta-rollback",
      title: "Original",
    });

    await runInDurableObject(stub, (instance: SessionDO) => {
      const repository = repositoryFor(instance);
      const session = repository.getSession();
      expect(session).not.toBeNull();

      instance.ctx.storage.sql.exec(`CREATE TRIGGER reject_session_view_delta
        BEFORE INSERT ON session_view_deltas
        BEGIN
          SELECT RAISE(ABORT, 'forced delta failure');
        END`);
      expect(() =>
        repository.updateSessionTitleWithViewDelta(session!.id, "Rolled back", 1_000)
      ).toThrow();
      expect(repository.getSession()?.title).toBe("Original");
      expect(repository.getCurrentViewRevision()).toBe(0);
      expect(repository.readContiguousSessionViewDeltas(0, 0)).toEqual([]);
      instance.ctx.storage.sql.exec("DROP TRIGGER reject_session_view_delta");

      repository.updateSessionTitleWithViewDelta(session!.id, "One", 2_000);
      repository.updateSessionTitleWithViewDelta(session!.id, "Two", 3_000);
      instance.ctx.storage.sql.exec("DELETE FROM session_view_deltas WHERE revision = 1");
      expect(repository.readContiguousSessionViewDeltas(0, 2)).toBeNull();
    });
  });

  it("retains a contiguous newest prefix after count and age pruning", async () => {
    const { stub } = await initSession({ sessionName: "view-delta-retention" });

    await runInDurableObject(stub, (instance: SessionDO) => {
      const repository = repositoryFor(instance);
      const session = repository.getSession();
      expect(session).not.toBeNull();
      for (let revision = 1; revision <= 5; revision += 1) {
        repository.updateSessionTitleWithViewDelta(
          session!.id,
          `Title ${revision}`,
          revision * 1_000
        );
      }

      expect(
        repository.pruneSessionViewDeltas({ maxRetainedRevisions: 2, createdBefore: 3_500 })
      ).toBe(3);
      expect(repository.readContiguousSessionViewDeltas(3, 5)?.map((row) => row.revision)).toEqual([
        4, 5,
      ]);
      expect(repository.readContiguousSessionViewDeltas(2, 5)).toBeNull();
    });
  });
});
