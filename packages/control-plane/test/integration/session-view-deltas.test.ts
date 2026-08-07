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
  it("commits status, sandbox, event, and artifact projections as canonical deltas", async () => {
    const { stub } = await initSession({ sessionName: "view-delta-canonical" });

    await runInDurableObject(stub, (instance: SessionDO) => {
      const repository = repositoryFor(instance);
      const session = repository.getSession()!;
      const start = repository.getCurrentViewRevision();
      const timestamp = Date.now();
      repository.updateSessionStatusWithViewDelta(session.id, "active", timestamp);
      repository.updateSandboxStatusWithViewDelta("ready", timestamp + 1);
      repository.createEventWithViewDelta({
        id: "canonical-event",
        type: "tool_result",
        data: JSON.stringify({
          type: "tool_result",
          sandboxId: "sandbox-1",
          timestamp,
          messageId: "message-1",
          callId: "call-1",
          result: "ok",
        }),
        messageId: "message-1",
        createdAt: timestamp + 2,
      });
      repository.createArtifactWithViewDelta({
        id: "canonical-artifact",
        type: "screenshot",
        url: "https://example.test/screenshot.png",
        metadata: null,
        createdAt: timestamp + 3,
      });

      const records = repository.readContiguousSessionViewDeltas(start, start + 4)!;
      expect(records.map((record) => record.revision)).toEqual([
        start + 1,
        start + 2,
        start + 3,
        start + 4,
      ]);
      expect(records[2].delta.operations[0]).toMatchObject({
        type: "event_upsert",
        item: { eventId: "canonical-event", timelineSequence: expect.any(Number) },
      });
      expect(records[3].delta.operations[0]).toMatchObject({
        type: "artifact_upsert",
        artifact: { id: "canonical-artifact" },
      });
    });
  });

  it("atomically commits projection changes with increasing revisions", async () => {
    const { stub } = await initSession({ sessionName: "view-delta-commit" });

    await runInDurableObject(stub, (instance: SessionDO) => {
      const repository = repositoryFor(instance);
      const session = repository.getSession();
      expect(session).not.toBeNull();
      const baselineRevision = repository.getCurrentViewRevision();

      const firstRevision = repository.updateSessionTitleWithViewDelta(session!.id, "First", 1_000);
      const secondRevision = repository.updateSessionTitleWithViewDelta(
        session!.id,
        "Second",
        2_000
      );

      expect([firstRevision, secondRevision]).toEqual([baselineRevision + 1, baselineRevision + 2]);
      expect(repository.getSession()?.title).toBe("Second");
      expect(
        repository
          .readContiguousSessionViewDeltas(baselineRevision, baselineRevision + 2)
          ?.map((row) => row.revision)
      ).toEqual([baselineRevision + 1, baselineRevision + 2]);
      expect(
        repository.readContiguousSessionViewDeltas(baselineRevision + 2, baselineRevision + 2)
      ).toEqual([]);
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
      const baselineRevision = repository.getCurrentViewRevision();

      expect(() =>
        repository.updateSessionTitleWithViewDelta("missing-session", "Not applied", 500)
      ).toThrow("did not match a session");
      expect(repository.getCurrentViewRevision()).toBe(baselineRevision);
      expect(
        repository.readContiguousSessionViewDeltas(baselineRevision, baselineRevision)
      ).toEqual([]);

      instance.ctx.storage.sql.exec(`CREATE TRIGGER reject_session_view_delta
        BEFORE INSERT ON session_view_deltas
        BEGIN
          SELECT RAISE(ABORT, 'forced delta failure');
        END`);
      expect(() =>
        repository.updateSessionTitleWithViewDelta(session!.id, "Rolled back", 1_000)
      ).toThrow();
      expect(repository.getSession()?.title).toBe("Original");
      expect(repository.getCurrentViewRevision()).toBe(baselineRevision);
      expect(
        repository.readContiguousSessionViewDeltas(baselineRevision, baselineRevision)
      ).toEqual([]);
      instance.ctx.storage.sql.exec("DROP TRIGGER reject_session_view_delta");

      repository.updateSessionTitleWithViewDelta(session!.id, "One", 2_000);
      repository.updateSessionTitleWithViewDelta(session!.id, "Two", 3_000);
      instance.ctx.storage.sql.exec(
        "DELETE FROM session_view_deltas WHERE revision = ?",
        baselineRevision + 1
      );
      expect(
        repository.readContiguousSessionViewDeltas(baselineRevision, baselineRevision + 2)
      ).toBeNull();
    });
  });

  it("retains a contiguous newest prefix after count and age pruning", async () => {
    const { stub } = await initSession({ sessionName: "view-delta-retention" });

    await runInDurableObject(stub, (instance: SessionDO) => {
      const repository = repositoryFor(instance);
      const session = repository.getSession();
      expect(session).not.toBeNull();
      const baselineRevision = repository.getCurrentViewRevision();
      for (let revision = 1; revision <= 5; revision += 1) {
        repository.updateSessionTitleWithViewDelta(
          session!.id,
          `Title ${revision}`,
          revision * 1_000
        );
      }

      expect(
        repository.pruneSessionViewDeltas({ maxRetainedRevisions: 2, createdBefore: 3_500 })
      ).toBe(baselineRevision + 3);
      expect(
        repository
          .readContiguousSessionViewDeltas(baselineRevision + 3, baselineRevision + 5)
          ?.map((row) => row.revision)
      ).toEqual([baselineRevision + 4, baselineRevision + 5]);
      expect(
        repository.readContiguousSessionViewDeltas(baselineRevision + 2, baselineRevision + 5)
      ).toBeNull();
    });
  });
});
