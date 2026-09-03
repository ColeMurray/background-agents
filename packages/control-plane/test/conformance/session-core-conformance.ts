import { describe, expect, it } from "vitest";
import { ArtifactRepository } from "../../src/session/artifact-repository";
import { EventRepository } from "../../src/session/event-repository";
import { MessageRepository } from "../../src/session/message-repository";
import { ParticipantRepository } from "../../src/session/participant-repository";
import { SandboxRepository } from "../../src/session/sandbox-repository";
import { generateEncryptionKey } from "../../src/auth/crypto";
import { createLogger } from "../../src/logger";
import {
  AttachmentClaimConflictError,
  SessionAttachmentRepository,
} from "../../src/session/session-attachment-repository";
import { SessionCoreRepository } from "../../src/session/session-core-repository";
import type { SqlStorage, TransactionSync } from "../../src/session/sql-storage";
import { WsClientMappingRepository } from "../../src/session/ws-client-mapping-repository";

const conformanceLog = createLogger("conformance");

export interface SqlStorageFixture {
  sql: SqlStorage;
  transactionSync: TransactionSync;
}

/**
 * Runs one assertion against fresh, schema-initialized session storage.
 *
 * The callback is synchronous because Durable Object transactions are synchronous.
 * A Node host can satisfy the same contract with an in-process SQLite database.
 */
export type SqlStorageFactory = <T>(run: (fixture: SqlStorageFixture) => T) => Promise<T>;

export type StorageContractId =
  | "repository.session-core"
  | "repository.message"
  | "repository.event"
  | "repository.sandbox"
  | "repository.participant"
  | "repository.artifact"
  | "repository.session-attachment"
  | "repository.ws-client-mapping";

/**
 * Host contracts are behaviors of the live runtime (claiming, sockets) that a
 * storage factory cannot exercise. A host declares each one with
 * `hostContract(id, …)` inside its own integration suite; the title is owned
 * here so the same contract reads the same on every host.
 */
export const HOST_CONTRACTS = {
  "host.concurrent-prompt-claim": {
    title: "dispatches exactly one of two concurrent prompts and leaves the other queued",
  },
  "host.socket-terminal-upgrade": {
    title: "revalidates terminal state after asynchronous authentication",
  },
  "host.socket-single-sandbox": {
    title: "keeps exactly one sandbox socket and tags it with the persisted sandbox ID",
  },
  "host.socket-ack-redelivery": {
    title: "acknowledges a re-flushed completion without duplicating durable effects",
  },
} as const;

export type HostContractId = keyof typeof HOST_CONTRACTS;

/** Declare the test that implements `id` on this host. There is no skipped form. */
export function hostContract(id: HostContractId, implementation: () => Promise<void>): void {
  it(HOST_CONTRACTS[id].title, implementation);
}

/**
 * The storage contracts, keyed by stable id. Every host runs all of them
 * against its own session storage through `registerSessionCoreConformanceSuite`.
 */
export const STORAGE_CONTRACTS: Record<
  StorageContractId,
  (storageFactory: SqlStorageFactory) => void
> = {
  "repository.session-core": (storageFactory) =>
    describe("session-core repository conformance", () => {
      it("persists session and member repository updates", async () => {
        await storageFactory(({ sql, transactionSync }) => {
          const repository = new SessionCoreRepository(sql, transactionSync);
          sql.exec("DELETE FROM session");
          repository.upsertSession({
            id: "conformance-session",
            sessionName: "conformance",
            title: null,
            repoOwner: "acme",
            repoName: "app",
            repoId: 42,
            baseBranch: "main",
            model: "anthropic/claude-haiku-4-5",
            status: "created",
            createdAt: 100,
            updatedAt: 100,
          });
          repository.replaceSessionRepositories([
            {
              position: 0,
              repoOwner: "acme",
              repoName: "app",
              repoId: 42,
              baseBranch: "main",
            },
          ]);

          expect(
            repository.updateSessionTitleIfUnset("conformance-session", "Generated", 200)
          ).toBe(true);
          expect(repository.updateSessionTitleIfUnset("conformance-session", "Ignored", 300)).toBe(
            false
          );
          expect(repository.getSession()).toMatchObject({
            id: "conformance-session",
            title: "Generated",
            repo_owner: "acme",
            repo_name: "app",
          });
          expect(repository.getSessionRepositoryRows()).toMatchObject([
            { position: 0, repo_owner: "acme", repo_name: "app", repo_id: 42 },
          ]);

          repository.setSessionDiffBaselines([
            {
              position: 0,
              repoOwner: "ACME",
              repoName: "APP",
              baseSha: "base-sha",
              isPrimary: true,
            },
          ]);
          repository.setSessionDiffBaselines([
            {
              position: 0,
              repoOwner: "acme",
              repoName: "app",
              baseSha: "ignored-sha",
              isPrimary: true,
            },
          ]);
          expect(repository.getSession()).toMatchObject({ base_sha: "base-sha" });
          expect(repository.getSessionRepositoryRows()).toMatchObject([{ base_sha: "base-sha" }]);
        });
      });

      it("enforces repository context constraints", async () => {
        await storageFactory(({ sql, transactionSync }) => {
          const repository = new SessionCoreRepository(sql, transactionSync);
          expect(() =>
            repository.upsertSession({
              id: "invalid-session",
              sessionName: "invalid",
              title: null,
              repoOwner: "acme",
              repoName: null,
              model: "model",
              status: "created",
              createdAt: 1,
              updatedAt: 1,
            })
          ).toThrow("repoOwner and repoName together");
        });
      });
    }),
  "repository.message": (storageFactory) =>
    describe("message repository conformance", () => {
      it("allows one processing claim and applies a redelivered completion once", async () => {
        await storageFactory(({ sql, transactionSync }) => {
          const attachments = new SessionAttachmentRepository(sql);
          const events = new EventRepository(sql, transactionSync);
          const repository = new MessageRepository(sql, transactionSync, attachments, events);
          const authorId = "message-author";
          new ParticipantRepository(sql).createParticipant({
            id: authorId,
            userId: "message-user",
            role: "member",
            joinedAt: 99,
          });
          for (const [id, createdAt] of [
            ["message-a", 100],
            ["message-b", 101],
          ] as const) {
            repository.createMessage({
              id,
              authorId,
              content: id,
              source: "web",
              status: "pending",
              createdAt,
            });
          }

          const userEvent = (messageId: string) => ({
            type: "user_message" as const,
            content: messageId,
            messageId,
            timestamp: 1,
            author: { participantId: authorId, userId: "message-user", name: "User" },
          });
          expect(repository.startMessageProcessing("message-a", 200, userEvent("message-a"))).toBe(
            true
          );
          expect(repository.startMessageProcessing("message-b", 201, userEvent("message-b"))).toBe(
            false
          );

          const completion = {
            type: "execution_complete" as const,
            messageId: "message-a",
            success: true,
            sandboxId: "sandbox-1",
            timestamp: 2,
          };
          expect(repository.recordMessageCompletion(completion, 300, "processing")?.status).toBe(
            "completed"
          );
          expect(repository.recordMessageCompletion(completion, 301, "processing")).toBeNull();
          expect(
            sql.exec("SELECT id FROM events WHERE id = ?", "execution_complete:message-a").toArray()
          ).toHaveLength(1);
        });
      });

      it("rolls back partial attachment claims and supports cancellation and pagination", async () => {
        await storageFactory(({ sql, transactionSync }) => {
          const attachments = new SessionAttachmentRepository(sql);
          const events = new EventRepository(sql, transactionSync);
          const repository = new MessageRepository(sql, transactionSync, attachments, events);
          const authorId = "message-author";
          new ParticipantRepository(sql).createParticipant({
            id: authorId,
            userId: "message-user",
            role: "member",
            joinedAt: 1,
          });
          attachments.create({
            id: "attachment-1",
            mimeType: "text/plain",
            sizeBytes: 1,
            objectKey: "attachment-1",
            createdAt: 1,
          });

          expect(() =>
            repository.createMessageWithAttachments(
              {
                id: "rolled-back-message",
                authorId,
                content: "rollback",
                source: "web",
                status: "pending",
                createdAt: 2,
              },
              ["attachment-1", "missing-attachment"]
            )
          ).toThrow(AttachmentClaimConflictError);
          expect(attachments.getUnreferenced(["attachment-1"])).toHaveLength(1);
          expect(
            sql.exec("SELECT id FROM messages WHERE id = 'rolled-back-message'").toArray()
          ).toEqual([]);

          for (const [id, createdAt] of [
            ["message-old", 10],
            ["message-middle", 20],
            ["message-new", 30],
          ] as const) {
            repository.createMessage({
              id,
              authorId,
              content: id,
              source: "web",
              status: "pending",
              createdAt,
            });
          }
          attachments.claimForMessage("message-middle", ["attachment-1"]);
          expect(repository.cancelPendingMessage("message-middle")).toBe(true);
          expect(attachments.getUnreferenced(["attachment-1"])).toHaveLength(1);
          expect(repository.cancelPendingMessage("message-middle")).toBe(false);
          expect(
            repository.listMessages({ limit: 1, status: "pending", cursor: "30" })
          ).toMatchObject([{ id: "message-old" }]);
          expect(repository.listPendingMessagesWithCreatedAt().map(({ id }) => id)).toEqual([
            "message-old",
            "message-new",
          ]);
        });
      });
    }),
  "repository.event": (storageFactory) =>
    describe("event repository conformance", () => {
      it("assigns stable timeline positions to upserted events", async () => {
        await storageFactory(({ sql, transactionSync }) => {
          const repository = new EventRepository(sql, transactionSync);
          repository.createEvent({
            id: "event-1",
            type: "status",
            data: "{}",
            messageId: null,
            createdAt: 100,
          });
          const token = {
            type: "token" as const,
            content: "first",
            messageId: "message-1",
            sandboxId: "sandbox-1",
            timestamp: 1,
          };
          repository.upsertTokenEvent("message-1", token, 101);
          repository.upsertTokenEvent("message-1", { ...token, content: "updated" }, 102);

          const rows = sql
            .exec("SELECT id, data, timeline_sequence FROM events ORDER BY timeline_sequence")
            .toArray() as Array<{ id: string; data: string; timeline_sequence: number }>;
          expect(rows.map(({ id, timeline_sequence }) => [id, timeline_sequence])).toEqual([
            ["event-1", 1],
            ["token:message-1", 2],
          ]);
          expect(JSON.parse(rows[1].data).content).toBe("updated");
        });
      });

      it("paginates deterministically and preserves ascending timeline projection", async () => {
        await storageFactory(({ sql, transactionSync }) => {
          const repository = new EventRepository(sql, transactionSync);
          for (const [id, createdAt] of [
            ["event-a", 100],
            ["event-b", 100],
            ["event-c", 200],
          ] as const) {
            repository.createEvent({ id, type: "status", data: id, messageId: null, createdAt });
          }

          const newest = repository.listEventPage({ limit: 2 });
          expect(newest.hasMore).toBe(true);
          expect(newest.events.map(({ id }) => id)).toEqual(["event-c", "event-b"]);
          expect(newest.nextCursor).not.toBeNull();
          expect(
            repository
              .getEventTimelinePage({ limit: 2, cursor: newest.nextCursor })
              .events.map(({ id }) => id)
          ).toEqual(["event-a"]);
        });
      });
    }),
  "repository.sandbox": (storageFactory) =>
    describe("sandbox repository conformance", () => {
      it("persists lifecycle and circuit-breaker changes", async () => {
        await storageFactory(({ sql }) => {
          sql.exec("DELETE FROM sandbox");
          // Generated here, not at module scope: Workers forbid random values
          // during module evaluation, and this module loads inside workerd.
          const repository = new SandboxRepository(sql, conformanceLog, generateEncryptionKey());
          repository.createSandbox({
            id: "sandbox-1",
            status: "pending",
            gitSyncStatus: "pending",
            createdAt: 100,
          });
          repository.updateSandboxStatus("ready");
          repository.incrementCircuitBreakerFailure(200);

          expect(repository.getSandbox()).toMatchObject({ id: "sandbox-1", status: "ready" });
          expect(repository.getSandboxWithCircuitBreaker()).toMatchObject({
            status: "ready",
            spawn_failure_count: 1,
            last_spawn_failure: 200,
          });

          sql.exec(
            `UPDATE sandbox SET modal_object_id = 'provider-1', code_server_url = 'old',
           vnc_url = 'old', tunnel_urls = '{}', ttyd_url = 'old'`
          );
          repository.updateSandboxForSpawn({
            status: "connecting",
            createdAt: 300,
            modalSandboxId: "sandbox-provider-id",
          });
          expect(repository.getSandbox()).toMatchObject({
            status: "connecting",
            modal_object_id: null,
            modal_sandbox_id: "sandbox-provider-id",
            code_server_url: null,
            vnc_url: null,
            tunnel_urls: null,
            ttyd_url: null,
          });
        });
      });
    }),
  "repository.participant": (storageFactory) =>
    describe("participant repository conformance", () => {
      it("persists participants and preserves fields on partial updates", async () => {
        await storageFactory(({ sql }) => {
          const repository = new ParticipantRepository(sql);
          repository.createParticipant({
            id: "participant-conformance",
            userId: "user-conformance",
            scmLogin: "original",
            role: "member",
            joinedAt: 100,
          });
          repository.updateParticipantCoalesce("participant-conformance", {
            scmLogin: null,
            scmName: "Conformance User",
          });

          expect(repository.getParticipantByUserId("user-conformance")).toMatchObject({
            id: "participant-conformance",
            scm_login: "original",
            scm_name: "Conformance User",
          });
          repository.updateParticipantWsToken("participant-conformance", "ws-hash", 200);
          repository.updateParticipantTokens("participant-conformance", {
            scmAccessTokenEncrypted: "access-2",
            scmRefreshTokenEncrypted: "refresh-2",
            scmTokenExpiresAt: 300,
          });
          expect(repository.getParticipantByWsTokenHash("ws-hash")).toMatchObject({
            scm_access_token_encrypted: "access-2",
            scm_refresh_token_encrypted: "refresh-2",
            scm_token_expires_at: 300,
          });

          repository.createParticipant({
            id: "participant-earlier",
            userId: "user-earlier",
            role: "owner",
            joinedAt: 50,
          });
          expect(
            repository
              .listParticipants()
              .map(({ id }) => id)
              .slice(0, 2)
          ).toEqual(["participant-earlier", "participant-conformance"]);
        });
      });
    }),
  "repository.artifact": (storageFactory) =>
    describe("artifact repository conformance", () => {
      it("creates, updates, and reads artifacts", async () => {
        await storageFactory(({ sql }) => {
          const repository = new ArtifactRepository(sql);
          repository.createArtifact({
            id: "artifact-1",
            type: "preview",
            url: "https://old.example",
            metadata: null,
            createdAt: 100,
          });
          repository.updateArtifact("artifact-1", {
            url: "https://new.example",
            metadata: '{"ready":true}',
            updatedAt: 200,
          });

          expect(repository.getArtifactById("artifact-1")).toMatchObject({
            url: "https://new.example",
            metadata: '{"ready":true}',
            created_at: 100,
            updated_at: 200,
          });
          repository.createArtifact({
            id: "artifact-2",
            type: "branch",
            url: null,
            metadata: null,
            createdAt: 300,
          });
          expect(repository.listArtifacts().map(({ id }) => id)).toEqual([
            "artifact-2",
            "artifact-1",
          ]);
          expect(repository.getArtifactById("missing")).toBeNull();
        });
      });
    }),
  "repository.session-attachment": (storageFactory) =>
    describe("session attachment repository conformance", () => {
      it("claims and releases attachments using rowsWritten", async () => {
        await storageFactory(({ sql }) => {
          const repository = new SessionAttachmentRepository(sql);
          repository.create({
            id: "attachment-1",
            mimeType: "text/plain",
            sizeBytes: 12,
            objectKey: "sessions/attachment-1",
            createdAt: 100,
          });

          expect(repository.getTotals()).toEqual({ count: 1, totalBytes: 12 });
          repository.claimForMessage("message-1", ["attachment-1"]);
          expect(repository.getUnreferenced(["attachment-1"])).toEqual([]);
          repository.releaseForMessage("message-1");
          expect(repository.getUnreferenced(["attachment-1"])).toHaveLength(1);

          expect(() =>
            repository.claimForMessage("message-2", ["attachment-1", "missing"])
          ).toThrow(AttachmentClaimConflictError);
        });
      });

      it("leases stale cleanup and enforces claim ownership", async () => {
        await storageFactory(({ sql }) => {
          const repository = new SessionAttachmentRepository(sql);
          repository.create({
            id: "stale-attachment",
            mimeType: "text/plain",
            sizeBytes: 5,
            objectKey: "stale",
            createdAt: 10,
          });

          expect(repository.claimStale(20, 30, 25)).toMatchObject([
            { id: "stale-attachment", cleanup_claimed_at: 30 },
          ]);
          expect(repository.claimStale(20, 40, 25)).toEqual([]);
          repository.acknowledgeCleanup(["stale-attachment"], 999);
          expect(repository.getTotals().count).toBe(1);
          repository.releaseCleanupClaims(["stale-attachment"], 30);
          expect(repository.claimStale(20, 40, 35)).toHaveLength(1);
          repository.acknowledgeCleanup(["stale-attachment"], 40);
          expect(repository.getTotals()).toEqual({ count: 0, totalBytes: 0 });
        });
      });
    }),
  "repository.ws-client-mapping": (storageFactory) =>
    describe("ws client mapping repository conformance", () => {
      it("joins mappings to participant identity", async () => {
        await storageFactory(({ sql }) => {
          const participants = new ParticipantRepository(sql);
          participants.createParticipant({
            id: "ws-participant",
            userId: "ws-user",
            canonicalUserId: "canonical-user",
            scmLogin: "octocat",
            role: "member",
            joinedAt: 100,
          });
          const repository = new WsClientMappingRepository(sql);
          repository.upsertWsClientMapping({
            wsId: "ws-1",
            participantId: "ws-participant",
            clientId: "client-1",
            createdAt: 101,
            authorizationExpiresAt: 1_000,
          });

          expect(repository.getWsClientMapping("ws-1")).toMatchObject({
            participant_id: "ws-participant",
            client_id: "client-1",
            user_id: "ws-user",
            canonical_user_id: "canonical-user",
            scm_login: "octocat",
          });
          expect(repository.hasWsClientMapping("ws-1")).toBe(true);

          participants.createParticipant({
            id: "ws-participant-2",
            userId: "ws-user-2",
            role: "member",
            joinedAt: 200,
          });
          repository.upsertWsClientMapping({
            wsId: "ws-1",
            participantId: "ws-participant-2",
            clientId: "client-2",
            createdAt: 201,
            authorizationExpiresAt: 2_000,
          });
          expect(repository.getWsClientMapping("ws-1")).toMatchObject({
            participant_id: "ws-participant-2",
            client_id: "client-2",
            user_id: "ws-user-2",
          });
        });
      });
    }),
};

/** Run every storage contract against `storageFactory`. */
export function registerSessionCoreConformanceSuite(storageFactory: SqlStorageFactory): void {
  for (const register of Object.values(STORAGE_CONTRACTS)) register(storageFactory);
}

/** What every host must satisfy, derived from the executable registrations above. */
export const SESSION_CORE_CONFORMANCE_MANIFEST = [
  ...(Object.keys(STORAGE_CONTRACTS) as StorageContractId[]).map((id) => ({
    id,
    scope: "storage" as const,
  })),
  ...(Object.keys(HOST_CONTRACTS) as HostContractId[]).map((id) => ({
    id,
    scope: "host" as const,
    title: HOST_CONTRACTS[id].title,
  })),
];
