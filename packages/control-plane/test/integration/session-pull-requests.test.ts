/**
 * SessionPullRequestStore: upsert with monotonic provider_updated_at guard,
 * identity lookups, legacy→external identity upgrade, grouped session
 * summaries, and the session-delete FK cascade. Exercises migration 0041 by
 * construction — the queries fail if it did not apply.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  SessionPullRequestStore,
  type SessionPullRequestRecord,
} from "../../src/db/session-pull-request-store";
import { SessionIndexStore } from "../../src/db/session-index";
import { cleanD1Tables } from "./cleanup";

async function seedSession(id: string): Promise<void> {
  const now = Date.now();
  await new SessionIndexStore(env.DB).create({
    id,
    title: null,
    repoOwner: "acme",
    repoName: "web",
    model: "test-model",
    reasoningEffort: null,
    baseBranch: "main",
    status: "initializing",
    createdAt: now,
    updatedAt: now,
  });
}

function makeRecord(overrides?: Partial<SessionPullRequestRecord>): SessionPullRequestRecord {
  const now = Date.now();
  return {
    artifactId: "artifact-1",
    sessionId: "session-1",
    repositoryExternalId: "9001",
    repoOwner: "acme",
    repoName: "web",
    prNumber: 7,
    url: "https://github.com/acme/web/pull/7",
    lifecycleState: "open",
    isDraft: true,
    headBranch: "open-inspect/session-1",
    baseBranch: "main",
    headSha: "abc123",
    providerUpdatedAt: 1_000,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("SessionPullRequestStore", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedSession("session-1");
  });

  describe("upsert + reads", () => {
    it("inserts a record and reads it back by artifact id and by identity", async () => {
      const store = new SessionPullRequestStore(env.DB);
      const record = makeRecord();

      const result = await store.upsert(record);
      expect(result.applied).toBe(true);

      expect(await store.getByArtifactId("artifact-1")).toEqual(record);
      expect(
        await store.getByIdentity({
          repositoryExternalId: "9001",
          repoOwner: "acme",
          repoName: "web",
          prNumber: 7,
        })
      ).toEqual(record);
    });

    it("rejects a terminal draft state — the invariant is enforced by the table", async () => {
      const store = new SessionPullRequestStore(env.DB);

      await expect(
        store.upsert(makeRecord({ lifecycleState: "merged", isDraft: true }))
      ).rejects.toThrow();
      await expect(
        store.upsert(makeRecord({ lifecycleState: "closed", isDraft: true }))
      ).rejects.toThrow();
      // The guard also covers the ON CONFLICT update arm.
      await store.upsert(makeRecord());
      await expect(
        store.upsert(
          makeRecord({ lifecycleState: "merged", isDraft: true, providerUpdatedAt: 2_000 })
        )
      ).rejects.toThrow();
      expect((await store.getByArtifactId("artifact-1"))?.lifecycleState).toBe("open");
    });

    it("is idempotent for a redelivered identical write", async () => {
      const store = new SessionPullRequestStore(env.DB);
      const record = makeRecord();

      await store.upsert(record);
      const second = await store.upsert(record);

      expect(second.applied).toBe(true);
      const rows = await store.getBySession("session-1");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(record);
    });

    it("applies a newer provider state", async () => {
      const store = new SessionPullRequestStore(env.DB);
      await store.upsert(makeRecord());

      const result = await store.upsert(
        makeRecord({ lifecycleState: "merged", isDraft: false, providerUpdatedAt: 2_000 })
      );

      expect(result.applied).toBe(true);
      const row = await store.getByArtifactId("artifact-1");
      expect(row?.lifecycleState).toBe("merged");
      expect(row?.providerUpdatedAt).toBe(2_000);
    });

    it("rejects an out-of-order (stale) write — the monotonic guard", async () => {
      const store = new SessionPullRequestStore(env.DB);
      await store.upsert(
        makeRecord({ lifecycleState: "merged", isDraft: false, providerUpdatedAt: 2_000 })
      );

      const stale = await store.upsert(
        makeRecord({ lifecycleState: "open", isDraft: false, providerUpdatedAt: 1_000 })
      );

      expect(stale.applied).toBe(false);
      const row = await store.getByArtifactId("artifact-1");
      expect(row?.lifecycleState).toBe("merged");
      expect(row?.providerUpdatedAt).toBe(2_000);
    });

    it("applies when the existing row has no provider timestamp", async () => {
      const store = new SessionPullRequestStore(env.DB);
      await store.upsert(makeRecord({ providerUpdatedAt: null }));

      const result = await store.upsert(
        makeRecord({ lifecycleState: "closed", isDraft: false, providerUpdatedAt: 1_000 })
      );

      expect(result.applied).toBe(true);
      expect((await store.getByArtifactId("artifact-1"))?.lifecycleState).toBe("closed");
    });

    it("applies an authoritative write that carries no provider timestamp", async () => {
      const store = new SessionPullRequestStore(env.DB);
      await store.upsert(makeRecord({ providerUpdatedAt: 2_000 }));

      const result = await store.upsert(
        makeRecord({ lifecycleState: "closed", isDraft: false, providerUpdatedAt: null })
      );

      expect(result.applied).toBe(true);
      expect((await store.getByArtifactId("artifact-1"))?.lifecycleState).toBe("closed");
    });

    it("falls back to legacy owner/name identity for rows that predate external-id capture", async () => {
      const store = new SessionPullRequestStore(env.DB);
      await store.upsert(makeRecord({ repositoryExternalId: null }));

      // One boundary: callers pass everything they know; the store layers
      // stable-id-first, legacy-fallback internally.
      const row = await store.getByIdentity({
        repositoryExternalId: "9001",
        repoOwner: "acme",
        repoName: "web",
        prNumber: 7,
      });

      expect(row?.artifactId).toBe("artifact-1");
      expect(row?.repositoryExternalId).toBeNull();
    });

    it("matches legacy identity case-insensitively (provider identifiers are case-insensitive)", async () => {
      const store = new SessionPullRequestStore(env.DB);
      await store.upsert(
        makeRecord({ repositoryExternalId: null, repoOwner: "Acme", repoName: "Web" })
      );

      const row = await store.getByIdentity({
        repositoryExternalId: null,
        repoOwner: "acme",
        repoName: "web",
        prNumber: 7,
      });

      expect(row?.artifactId).toBe("artifact-1");
    });

    it("returns null when neither identity arm matches", async () => {
      const store = new SessionPullRequestStore(env.DB);
      await store.upsert(makeRecord());

      expect(
        await store.getByIdentity({
          repositoryExternalId: "9999",
          repoOwner: "other",
          repoName: "repo",
          prNumber: 7,
        })
      ).toBeNull();
    });

    it("upgrades a legacy row (no external id) to external identity in place", async () => {
      const store = new SessionPullRequestStore(env.DB);
      await store.upsert(makeRecord({ repositoryExternalId: null }));

      await store.upsert(makeRecord({ providerUpdatedAt: 2_000 }));

      const row = await store.getByArtifactId("artifact-1");
      expect(row?.repositoryExternalId).toBe("9001");
      const rows = await store.getBySession("session-1");
      expect(rows).toHaveLength(1);
    });

    it("rejects a second record for the same PR identity under a different artifact id", async () => {
      const store = new SessionPullRequestStore(env.DB);
      await store.upsert(makeRecord());

      await expect(store.upsert(makeRecord({ artifactId: "artifact-2" }))).rejects.toThrow();
    });

    it("rejects a non-positive PR number (CHECK constraint)", async () => {
      const store = new SessionPullRequestStore(env.DB);
      await expect(store.upsert(makeRecord({ prNumber: 0 }))).rejects.toThrow();
    });
  });

  describe("summariesForSessions", () => {
    it("groups counts by display status per session and skips PR-less sessions", async () => {
      await seedSession("session-2");
      await seedSession("session-3");
      const store = new SessionPullRequestStore(env.DB);

      // session-1: one open-ready, one draft, one merged
      await store.upsert(
        makeRecord({ artifactId: "a1", prNumber: 1, repositoryExternalId: "9001", isDraft: false })
      );
      await store.upsert(
        makeRecord({ artifactId: "a2", prNumber: 2, repositoryExternalId: "9001", isDraft: true })
      );
      await store.upsert(
        makeRecord({
          artifactId: "a3",
          prNumber: 3,
          repositoryExternalId: "9001",
          lifecycleState: "merged",
          isDraft: false,
        })
      );
      // session-2: one closed
      await store.upsert(
        makeRecord({
          artifactId: "b1",
          sessionId: "session-2",
          prNumber: 4,
          repositoryExternalId: "9001",
          lifecycleState: "closed",
          isDraft: false,
        })
      );

      const summaries = await store.summariesForSessions(["session-1", "session-2", "session-3"]);

      expect(summaries.get("session-1")).toEqual({
        total: 3,
        open: 1,
        draft: 1,
        merged: 1,
        closed: 0,
      });
      expect(summaries.get("session-2")).toEqual({
        total: 1,
        open: 0,
        draft: 0,
        merged: 0,
        closed: 1,
      });
      expect(summaries.has("session-3")).toBe(false);
    });

    it("returns an empty map for an empty id list without querying", async () => {
      const store = new SessionPullRequestStore(env.DB);
      expect((await store.summariesForSessions([])).size).toBe(0);
    });
  });

  describe("deletion", () => {
    it("cascades when the session row is deleted", async () => {
      const store = new SessionPullRequestStore(env.DB);
      await store.upsert(makeRecord());

      await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind("session-1").run();

      expect(await store.getByArtifactId("artifact-1")).toBeNull();
    });

    it("deleteBySession removes only that session's records", async () => {
      await seedSession("session-2");
      const store = new SessionPullRequestStore(env.DB);
      await store.upsert(makeRecord());
      await store.upsert(
        makeRecord({
          artifactId: "b1",
          sessionId: "session-2",
          prNumber: 8,
          repositoryExternalId: "9001",
        })
      );

      await store.deleteBySession("session-1");

      expect(await store.getByArtifactId("artifact-1")).toBeNull();
      expect(await store.getByArtifactId("b1")).not.toBeNull();
    });
  });
});
