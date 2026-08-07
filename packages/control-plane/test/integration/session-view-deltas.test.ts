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

      const firstRevision = repository.appendSessionViewDelta(
        { operations: [{ type: "state_patch", patch: { title: "First" } }] },
        1_000,
        () => {
          repository.updateSessionTitle(session!.id, "First", 1_000);
          return true;
        }
      );
      const secondRevision = repository.appendSessionViewDelta(
        { operations: [{ type: "state_patch", patch: { title: "Second" } }] },
        2_000,
        () => {
          repository.updateSessionTitle(session!.id, "Second", 2_000);
          return true;
        }
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

      expect(() =>
        repository.appendSessionViewDelta(
          { operations: [{ type: "state_patch", patch: { title: "Rolled back" } }] },
          1_000,
          () => {
            repository.updateSessionTitle(session!.id, "Rolled back", 1_000);
            throw new Error("abort projection");
          }
        )
      ).toThrow("abort projection");
      expect(repository.getSession()?.title).toBe("Original");
      expect(repository.getCurrentViewRevision()).toBe(0);
      expect(repository.readContiguousSessionViewDeltas(0, 0)).toEqual([]);

      repository.appendSessionViewDelta(
        { operations: [{ type: "state_patch", patch: { title: "One" } }] },
        2_000,
        () => true
      );
      repository.appendSessionViewDelta(
        { operations: [{ type: "state_patch", patch: { title: "Two" } }] },
        3_000,
        () => true
      );
      instance.ctx.storage.sql.exec("DELETE FROM session_view_deltas WHERE revision = 1");
      expect(repository.readContiguousSessionViewDeltas(0, 2)).toBeNull();
    });
  });

  it("retains a contiguous newest prefix after count and age pruning", async () => {
    const { stub } = await initSession({ sessionName: "view-delta-retention" });

    await runInDurableObject(stub, (instance: SessionDO) => {
      const repository = repositoryFor(instance);
      for (let revision = 1; revision <= 5; revision += 1) {
        repository.appendSessionViewDelta(
          { operations: [{ type: "state_patch", patch: { title: `Title ${revision}` } }] },
          revision * 1_000,
          () => true
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
