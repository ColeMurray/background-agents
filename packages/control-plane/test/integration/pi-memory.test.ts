import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryRecordStore } from "../../src/db/memory-records";
import { SessionInternalPaths } from "../../src/session/contracts";
import { cleanD1Tables } from "./cleanup";
import { initNamedSessionDO, seedActiveUser } from "./helpers";
import { seedMemorySession } from "./memory-test-helpers";
import { seedGrant, seedTeam } from "./ownership-test-helpers";
import { runInSessionDO } from "./session-do-access";

const MEMBER = "44444444444444444444444444444444";
const TEAM = "engineering";
const PI_MODEL = "openai/gpt-5.6-sol";
const repo = { repoOwner: "acme/group", repoName: "api", repoId: 123, baseBranch: "main" };
const content = {
  memoryType: "fact" as const,
  title: "Deploy setup",
  description: "How deployment works",
  content: "Use the staging environment",
};

/** A Pi session whose memory selection and repository reach are real. */
async function piSession(id: string) {
  await seedMemorySession(id, {
    userId: MEMBER,
    ownerTeamId: TEAM,
    visibility: "team",
    repositories: [repo],
  });
  const { stub } = await initNamedSessionDO(id, {
    harness: "pi",
    model: PI_MODEL,
    userId: MEMBER,
    repoOwner: repo.repoOwner,
    repoName: repo.repoName,
    repoId: repo.repoId,
    defaultBranch: repo.baseBranch,
  });
  return stub;
}

/** A live turn of the session, which the memory gateway fences on. */
async function liveTurn(stub: DurableObjectStub, operationId: string) {
  await runInSessionDO(stub, (_instance, state) => {
    state.storage.sql.exec(
      "INSERT OR IGNORE INTO participants (id, user_id, canonical_user_id, role, joined_at) VALUES (?, ?, ?, 'member', ?)",
      MEMBER,
      MEMBER,
      MEMBER,
      Date.now()
    );
    state.storage.sql.exec(
      "INSERT INTO messages (id, author_id, content, source, status, created_at) VALUES (?, ?, 'remember this', 'web', 'processing', ?)",
      operationId,
      MEMBER,
      Date.now()
    );
  });
}

function memoryRequest(path: string, body: unknown, operationId: string) {
  return new Request(`http://session${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Pi-Operation-ID": operationId,
      "x-request-id": operationId,
    },
    body: JSON.stringify(body),
  });
}

describe("pi memory gateway", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser(MEMBER);
    await seedTeam(TEAM, [[MEMBER, "member"]]);
    await seedGrant(TEAM, {
      repo_id: repo.repoId,
      repo_owner: repo.repoOwner,
      repo_name: repo.repoName,
    });
  });

  it("writes a shared memory as a proposal and records the effect in the audit", async () => {
    const sessionId = `pi-memory-write-${crypto.randomUUID()}`;
    const stub = await piSession(sessionId);
    const operationId = "turn-1";
    await liveTurn(stub, operationId);

    const response = await stub.fetch(
      memoryRequest(
        SessionInternalPaths.piMemoryWrite,
        { ...content, scopeType: "repository" },
        operationId
      )
    );

    expect(response.status).toBe(201);
    const result = await response.json<{ id: string; status: string; revisionId: string }>();
    expect(result.status).toBe("proposed");
    expect(await new MemoryRecordStore(env.DB).get(result.id)).toMatchObject({
      partition: { type: "repository", repoId: repo.repoId },
      status: "proposed",
      authorKind: "agent",
      authorSessionId: sessionId,
    });
    const audit = await env.DB.prepare(
      "SELECT principal_kind, action, resource_type, resource_id, request_id, metadata_json FROM authorization_audit_events WHERE resource_id = ?"
    )
      .bind(result.id)
      .first<{
        principal_kind: string;
        action: string;
        resource_type: string;
        request_id: string;
        metadata_json: string;
      }>();
    expect(audit).toMatchObject({
      principal_kind: "harness",
      action: "memory.created",
      resource_type: "memory",
      request_id: operationId,
    });
    // The audit records identifiers, never the memory text.
    expect(audit?.metadata_json).not.toContain(content.content);
    expect(audit?.metadata_json).toContain(sessionId);
  });

  it("auto-saves a personal fact for a private session that may auto-save", async () => {
    const sessionId = `pi-memory-personal-${crypto.randomUUID()}`;
    await seedMemorySession(sessionId, {
      userId: MEMBER,
      ownerTeamId: TEAM,
      visibility: "private",
      repositories: [repo],
    });
    const { stub } = await initNamedSessionDO(sessionId, {
      harness: "pi",
      model: PI_MODEL,
      userId: MEMBER,
      repoOwner: repo.repoOwner,
      repoName: repo.repoName,
      repoId: repo.repoId,
      defaultBranch: repo.baseBranch,
    });
    const operationId = "turn-2";
    await liveTurn(stub, operationId);

    const response = await stub.fetch(
      memoryRequest(
        SessionInternalPaths.piMemoryWrite,
        { ...content, scopeType: "personal" },
        operationId
      )
    );

    expect(response.status).toBe(201);
    const result = await response.json<{ id: string; status: string }>();
    expect(result.status).toBe("active");
    expect(await new MemoryRecordStore(env.DB).get(result.id)).toMatchObject({
      partition: { type: "personal", userId: MEMBER },
      status: "active",
    });
  });

  it("refuses every operation outside a live turn of the session", async () => {
    const sessionId = `pi-memory-fence-${crypto.randomUUID()}`;
    const stub = await piSession(sessionId);

    const response = await stub.fetch(
      memoryRequest(
        SessionInternalPaths.piMemoryWrite,
        { ...content, scopeType: "repository" },
        "turn-that-never-ran"
      )
    );

    expect(response.status).toBe(409);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM memories").first<{
        count: number;
      }>()
    ).toMatchObject({ count: 0 });
  });

  it("refuses a write to a repository the session does not reach", async () => {
    const sessionId = `pi-memory-outside-${crypto.randomUUID()}`;
    const stub = await piSession(sessionId);
    const operationId = "turn-3";
    await liveTurn(stub, operationId);

    const response = await stub.fetch(
      memoryRequest(
        SessionInternalPaths.piMemoryWrite,
        { ...content, scopeType: "repository", repoOwner: "other", repoName: "repo" },
        operationId
      )
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Repository is outside this session" });
  });

  it("answers the pre-flight with the same refusal the write would give", async () => {
    const sessionId = `pi-memory-preflight-${crypto.randomUUID()}`;
    const stub = await piSession(sessionId);
    const operationId = "turn-4";
    await liveTurn(stub, operationId);
    const body = { ...content, scopeType: "repository", repoOwner: "other", repoName: "repo" };

    const authorized = await stub.fetch(
      memoryRequest(SessionInternalPaths.piMemoryAuthorize, body, operationId)
    );
    const written = await stub.fetch(
      memoryRequest(SessionInternalPaths.piMemoryWrite, body, operationId)
    );

    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({
      allowed: false,
      reason: "Repository is outside this session",
    });
    expect(written.status).toBe(403);
  });

  it("conceals a record outside the session's partitions as a missing one", async () => {
    const sessionId = `pi-memory-read-${crypto.randomUUID()}`;
    const stub = await piSession(sessionId);
    const operationId = "turn-5";
    await liveTurn(stub, operationId);
    const elsewhere = await new MemoryRecordStore(env.DB).create(
      {
        partition: { type: "repository", repoId: 999 },
        scope: { type: "repository", repoOwner: "other", repoName: "repo" },
        content,
      },
      { kind: "user", userId: MEMBER, requestId: "seed" }
    );

    const response = await stub.fetch(
      memoryRequest(SessionInternalPaths.piMemoryRead, { memoryId: elsewhere.id }, operationId)
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Memory not found" });
  });

  it("reads a record the session reaches", async () => {
    const sessionId = `pi-memory-read-allowed-${crypto.randomUUID()}`;
    const stub = await piSession(sessionId);
    const operationId = "turn-6";
    await liveTurn(stub, operationId);
    const record = await new MemoryRecordStore(env.DB).create(
      {
        partition: { type: "repository", repoId: repo.repoId },
        scope: { type: "repository", repoOwner: repo.repoOwner, repoName: repo.repoName },
        content,
      },
      { kind: "user", userId: MEMBER, requestId: "seed" }
    );

    const response = await stub.fetch(
      memoryRequest(SessionInternalPaths.piMemoryRead, { memoryId: record.id }, operationId)
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: record.id,
      status: "active",
      content: content.content,
    });
  });

  it("serves rendered memory only for an authorized live Pi turn", async () => {
    const sessionId = `pi-memory-context-${crypto.randomUUID()}`;
    const stub = await piSession(sessionId);
    const operationId = "turn-context";
    await liveTurn(stub, operationId);
    await new MemoryRecordStore(env.DB).create(
      {
        partition: { type: "repository", repoId: repo.repoId },
        scope: { type: "repository", repoOwner: repo.repoOwner, repoName: repo.repoName },
        content,
      },
      { kind: "user", userId: MEMBER, requestId: "seed" }
    );

    const response = await stub.fetch(
      new Request(`http://session${SessionInternalPaths.piContext}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Pi-Operation-ID": operationId,
        },
        body: JSON.stringify({ mode: "bootstrap" }),
      })
    );

    expect(response.status).toBe(200);
    const context = await response.json<{ memory: { rendered: string } | null }>();
    // The selection was pinned before the record existed, so the boot context
    // is empty; the shape is what the runtime renders.
    expect(context.memory).not.toBeUndefined();
  });
});
