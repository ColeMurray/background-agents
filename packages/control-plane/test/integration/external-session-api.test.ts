import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashToken } from "../../src/auth/crypto";
import { externalCreateSessionRequestSchema } from "@open-inspect/shared/types/external-session-api";
import { GlobalSecretsStore } from "../../src/db/global-secrets";
import { cleanD1Tables } from "./cleanup";
import { SessionIndexStore } from "../../src/db/session-index";
import { deriveExternalSessionId } from "../../src/routes/external-sessions";
import { encodeEventChangeCursor, parseEventChangeCursor } from "../../src/session/event-stream";
import {
  deleteEvent,
  queryDO,
  renameEvent,
  seedActiveUser,
  seedEvents,
  updateEventData,
  waitForSandboxStatus,
  serviceFetch,
} from "./helpers";

const API = "https://cp.test/external/v1/sessions";
const USER_ID = "33333333333333333333333333333333";

function externalSessionIdSecret(): string {
  if (!env.EXTERNAL_SESSION_ID_SECRET) throw new Error("Missing test external session ID secret");
  return env.EXTERNAL_SESSION_ID_SECRET;
}

async function externalHeaders(roleId = "role_builtin_member"): Promise<Record<string, string>> {
  await seedActiveUser(USER_ID);
  await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
    .bind(roleId, USER_ID)
    .run();
  const credential = `oi_cli_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.prepare(
    `INSERT INTO cli_credentials (id, token_hash, user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind("credential-1", await hashToken(credential), USER_ID, Date.now(), Date.now() + 60_000)
    .run();
  return { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" };
}

function createBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: "External session",
    model: "openai/gpt-5.6-sol",
    reasoningEffort: "high",
    idempotencyKey: `create-${crypto.randomUUID()}`,
    ...overrides,
  });
}

describe("external v1 session API", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  it("rejects unsupported fields and invalid explicit model settings before side effects", async () => {
    const headers = await externalHeaders();
    for (const body of [
      createBody({ repoOwner: "acme" }),
      createBody({ attachments: [] }),
      createBody({ skillSelection: { mode: "all" } }),
      createBody({ providerSelections: {} }),
      createBody({ model: "unknown/model" }),
      createBody({ model: "anthropic/claude-haiku-4-5", reasoningEffort: "low" }),
    ]) {
      const response = await SELF.fetch(API, { method: "POST", headers, body });
      expect(response.status, body).toBe(400);
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first()).toEqual({
      count: 0,
    });
  });

  it("rejects models disabled by the effective workspace policy on create and follow-up", async () => {
    const headers = await externalHeaders();
    await env.DB.prepare(
      "INSERT INTO model_preferences (id, enabled_models, updated_at) VALUES ('global', ?, ?)"
    )
      .bind(JSON.stringify(["anthropic/claude-sonnet-4-6"]), Date.now())
      .run();

    const deniedCreate = await SELF.fetch(API, { method: "POST", headers, body: createBody() });
    expect(deniedCreate.status).toBe(400);
    await expect(deniedCreate.json()).resolves.toEqual({
      error: 'Model "openai/gpt-5.6-sol" is not enabled',
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first()).toEqual({
      count: 0,
    });

    await env.DB.prepare("DELETE FROM model_preferences").run();
    const created = await SELF.fetch(API, { method: "POST", headers, body: createBody() });
    const { sessionId } = (await created.json()) as { sessionId: string };
    await env.DB.prepare(
      "INSERT INTO model_preferences (id, enabled_models, updated_at) VALUES ('global', ?, ?)"
    )
      .bind(JSON.stringify(["anthropic/claude-sonnet-4-6"]), Date.now())
      .run();
    const deniedPrompt = await SELF.fetch(`${API}/${sessionId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: "Continue",
        clientRequestId: "disabled-model",
        model: "openai/gpt-5.6-sol",
        reasoningEffort: "high",
      }),
    });
    expect(deniedPrompt.status).toBe(400);
    const deniedWebPrompt = await serviceFetch(`https://cp.test/sessions/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Continue",
        model: "openai/gpt-5.6-sol",
        reasoningEffort: "high",
      }),
    });
    expect(deniedWebPrompt.status).toBe(deniedPrompt.status);
    await expect(deniedWebPrompt.json()).resolves.toEqual(await deniedPrompt.json());
    const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
    expect((await queryDO(stub, "SELECT id FROM messages")).length).toBe(0);
  });

  it("allows create without reasoning for a non-reasoning model", async () => {
    const headers = await externalHeaders();
    const response = await SELF.fetch(API, {
      method: "POST",
      headers,
      body: createBody({
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: undefined,
      }),
    });
    expect(response.status).toBe(201);
    const { sessionId } = await response.json<{ sessionId: string }>();
    expect(
      await env.DB.prepare("SELECT reasoning_effort FROM sessions WHERE id = ?")
        .bind(sessionId)
        .first()
    ).toEqual({ reasoning_effort: null });
  });

  it("requires create and collaborate permissions before an initial-prompt side effect", async () => {
    const roleId = "role_external_create_only";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO roles (id, key, name, normalized_name, description, is_system)
         VALUES (?, NULL, 'External Create', 'external create', NULL, 0)`
      ).bind(roleId),
      env.DB.prepare(
        "INSERT INTO role_permissions (role_id, permission_id) VALUES (?, 'sessions.create')"
      ).bind(roleId),
    ]);
    const headers = await externalHeaders(roleId);
    const denied = await SELF.fetch(API, {
      method: "POST",
      headers,
      body: createBody({ initialPrompt: "Start work" }),
    });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      code: "permission_required",
      permission: "sessions.collaborate",
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first()).toEqual({
      count: 0,
    });
  });

  it("creates idempotently with a deterministic session and prompt response", async () => {
    const headers = await externalHeaders();
    const body = createBody({
      idempotencyKey: "initial-prompt-retry",
      initialPrompt: "Start work",
    });
    const first = await SELF.fetch(API, { method: "POST", headers, body });
    expect(first.status).toBe(201);
    const result = (await first.json()) as { sessionId: string; messageId: string };

    const retry = await SELF.fetch(API, { method: "POST", headers, body });
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toEqual(result);
    const conflict = await SELF.fetch(API, {
      method: "POST",
      headers,
      body: createBody({ idempotencyKey: "initial-prompt-retry", initialPrompt: "Different work" }),
    });
    expect(conflict.status).toBe(409);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first()).toEqual({
      count: 1,
    });
    expect(
      await env.DB.prepare("SELECT external_request_fingerprint FROM sessions WHERE id = ?")
        .bind(result.sessionId)
        .first()
    ).toEqual({
      external_request_fingerprint: await hashToken(
        JSON.stringify(externalCreateSessionRequestSchema.parse(JSON.parse(body)))
      ),
    });
    const stub = env.SESSION.get(env.SESSION.idFromName(result.sessionId));
    expect((await queryDO(stub, "SELECT id FROM messages")).length).toBe(1);
  });

  it("reserves the full request fingerprint before bootstrap and rejects changed crash retries", async () => {
    const headers = await externalHeaders();
    const idempotencyKey = `d1-crash-${crypto.randomUUID()}`;
    const body = createBody({ idempotencyKey, initialPrompt: "Original prompt" });
    const fingerprint = await hashToken(
      JSON.stringify(externalCreateSessionRequestSchema.parse(JSON.parse(body)))
    );
    const sessionId = await deriveExternalSessionId(
      USER_ID,
      idempotencyKey,
      externalSessionIdSecret()
    );
    const now = Date.now();
    await new SessionIndexStore(env.DB).create({
      id: sessionId,
      title: "External session",
      repoOwner: null,
      repoName: null,
      model: "openai/gpt-5.6-sol",
      reasoningEffort: "high",
      baseBranch: null,
      status: "created",
      userId: USER_ID,
      externalRequestFingerprint: fingerprint,
      createdAt: now,
      updatedAt: now,
    });

    const changed = await SELF.fetch(API, {
      method: "POST",
      headers,
      body: createBody({ idempotencyKey, initialPrompt: "Changed prompt" }),
    });
    expect(changed.status).toBe(409);
    await expect(changed.json()).resolves.toEqual({ error: "Idempotency key conflict" });
    const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
    expect(
      await queryDO(
        stub,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'"
      )
    ).toEqual([]);
  });

  it("derives IDs only from the dedicated external-session secret", async () => {
    const key = `secret-separation-${crypto.randomUUID()}`;
    const expected = await deriveExternalSessionId(USER_ID, key, externalSessionIdSecret());
    expect(await deriveExternalSessionId(USER_ID, key, externalSessionIdSecret())).toBe(expected);
    expect(await deriveExternalSessionId(USER_ID, key, env.TOKEN_ENCRYPTION_KEY)).not.toBe(
      expected
    );
  });

  it("converges concurrent identical creates onto one bootstrap aggregate", async () => {
    const headers = await externalHeaders();
    const body = createBody({ idempotencyKey: `concurrent-${crypto.randomUUID()}` });

    const responses = await Promise.all(
      Array.from({ length: 4 }, () => SELF.fetch(API, { method: "POST", headers, body }))
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 200, 201]);
    const results = await Promise.all(
      responses.map((response) => response.json<{ sessionId: string }>())
    );
    expect(new Set(results.map((result) => result.sessionId)).size).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first()).toEqual({
      count: 1,
    });
    const stub = env.SESSION.get(env.SESSION.idFromName(results[0]!.sessionId));
    expect((await queryDO(stub, "SELECT id FROM sandbox")).length).toBe(1);
    expect((await queryDO(stub, "SELECT id FROM participants")).length).toBe(1);
    expect((await queryDO(stub, "SELECT id FROM messages")).length).toBe(0);
  });

  it("lets exactly one differing concurrent create reserve and bootstrap", async () => {
    const headers = await externalHeaders();
    const idempotencyKey = `concurrent-conflict-${crypto.randomUUID()}`;
    const bodies = [
      createBody({ idempotencyKey, initialPrompt: "Prompt A" }),
      createBody({ idempotencyKey, initialPrompt: "Prompt B" }),
    ];

    const responses = await Promise.all(
      bodies.map((body) => SELF.fetch(API, { method: "POST", headers, body }))
    );
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const winnerIndex = responses.findIndex((response) => response.status === 201);
    const loserIndex = 1 - winnerIndex;
    const winner = await responses[winnerIndex]!.json<{ sessionId: string }>();
    await expect(responses[loserIndex]!.json()).resolves.toEqual({
      error: "Idempotency key conflict",
    });

    const winnerInput = externalCreateSessionRequestSchema.parse(JSON.parse(bodies[winnerIndex]!));
    const winnerFingerprint = await hashToken(JSON.stringify(winnerInput));
    expect(
      await env.DB.prepare("SELECT external_request_fingerprint FROM sessions WHERE id = ?")
        .bind(winner.sessionId)
        .first()
    ).toEqual({ external_request_fingerprint: winnerFingerprint });

    const stub = env.SESSION.get(env.SESSION.idFromName(winner.sessionId));
    const doFingerprint = await queryDO<{ initialization_fingerprint: string }>(
      stub,
      "SELECT initialization_fingerprint FROM session_bootstrap WHERE singleton = 1"
    );
    expect(doFingerprint).toHaveLength(1);
    expect(await queryDO(stub, "SELECT content FROM messages")).toEqual([
      { content: winnerInput.initialPrompt },
    ]);

    const winnerRetry = await SELF.fetch(API, {
      method: "POST",
      headers,
      body: bodies[winnerIndex],
    });
    expect(winnerRetry.status).toBe(200);
    expect(
      await queryDO(
        stub,
        "SELECT initialization_fingerprint FROM session_bootstrap WHERE singleton = 1"
      )
    ).toEqual(doFingerprint);
  });

  it.each(["active", "completed", "failed"] as const)(
    "does not regress an existing %s session when retrying runtime initialization",
    async (status) => {
      const headers = await externalHeaders();
      const idempotencyKey = `status-${status}`;
      const body = createBody({ idempotencyKey });
      const created = await SELF.fetch(API, { method: "POST", headers, body });
      const { sessionId } = (await created.json()) as { sessionId: string };
      await env.DB.prepare("UPDATE sessions SET status = ? WHERE id = ?")
        .bind(status, sessionId)
        .run();
      const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
      await queryDO(stub, "UPDATE session SET status = ?", status);
      const retry = await SELF.fetch(API, { method: "POST", headers, body });
      expect(retry.status).toBe(200);
      expect(
        await env.DB.prepare("SELECT status FROM sessions WHERE id = ?").bind(sessionId).first()
      ).toEqual({ status });
      expect(await queryDO(stub, "SELECT status FROM session")).toEqual([{ status }]);
    }
  );

  it("re-drives warming after the aggregate committed before warm scheduling", async () => {
    const headers = await externalHeaders();
    const body = createBody({ idempotencyKey: "warm-recovery" });
    const created = await SELF.fetch(API, { method: "POST", headers, body });
    const { sessionId } = (await created.json()) as { sessionId: string };
    const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
    await waitForSandboxStatus(stub, "failed");
    const aggregateBefore = {
      session: await queryDO(stub, "SELECT id, created_at FROM session"),
      sandbox: await queryDO(stub, "SELECT id FROM sandbox"),
      participants: await queryDO(stub, "SELECT id FROM participants ORDER BY id"),
    };
    await queryDO(stub, "UPDATE sandbox SET status = 'pending'");
    const retry = await SELF.fetch(API, { method: "POST", headers, body });

    expect(retry.status).toBe(200);
    expect(await queryDO(stub, "SELECT status FROM sandbox")).toEqual([{ status: "pending" }]);
    expect(
      await queryDO<{ pending_deadline: number | null }>(
        stub,
        "SELECT pending_deadline FROM session_alarm_state WHERE singleton = 1"
      )
    ).toEqual([expect.objectContaining({ pending_deadline: expect.any(Number) })]);
    expect({
      session: await queryDO(stub, "SELECT id, created_at FROM session"),
      sandbox: await queryDO(stub, "SELECT id FROM sandbox"),
      participants: await queryDO(stub, "SELECT id FROM participants ORDER BY id"),
    }).toEqual(aggregateBefore);
  });

  it("rejects a mismatched bootstrap fingerprint without rewriting the aggregate", async () => {
    const headers = await externalHeaders();
    const body = createBody({ idempotencyKey: "bootstrap-conflict" });
    const created = await SELF.fetch(API, { method: "POST", headers, body });
    const { sessionId } = (await created.json()) as { sessionId: string };
    const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
    const aggregateBefore = await queryDO(stub, "SELECT * FROM session");
    await queryDO(stub, "UPDATE session_bootstrap SET initialization_fingerprint = 'mismatch'");
    const retry = await SELF.fetch(API, { method: "POST", headers, body });

    expect(retry.status).toBe(409);
    await expect(retry.json()).resolves.toEqual({
      error: "Session runtime conflict",
      code: "runtime_conflict",
    });
    expect(await queryDO(stub, "SELECT * FROM session")).toEqual(aggregateBefore);
  });

  it("allows workspace-wide read and lifecycle to Member but denies Viewer and custom roles", async () => {
    const headers = await externalHeaders();
    const created = await SELF.fetch(API, { method: "POST", headers, body: createBody() });
    const { sessionId } = (await created.json()) as { sessionId: string };
    await env.DB.prepare("UPDATE sessions SET user_id = '44444444444444444444444444444444'").run();

    expect((await SELF.fetch(API, { headers })).status).toBe(200);
    const got = await SELF.fetch(`${API}/${sessionId}`, { headers });
    expect(got.status).toBe(200);
    const session = (await got.json()) as Record<string, unknown>;
    expect(session).toMatchObject({ id: sessionId });
    expect(session).not.toHaveProperty("repoOwner");
    expect((await SELF.fetch(`${API}/${sessionId}/stop`, { method: "POST", headers })).status).toBe(
      200
    );

    await env.DB.prepare("UPDATE user_role_assignments SET role_id = 'role_builtin_viewer'").run();
    expect((await SELF.fetch(API, { method: "POST", headers, body: createBody() })).status).toBe(
      403
    );
    expect((await SELF.fetch(`${API}/${sessionId}/stop`, { method: "POST", headers })).status).toBe(
      403
    );
    expect((await SELF.fetch(API, { headers })).status).toBe(200);

    const roleId = "role_no_session_read";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO roles (id, key, name, normalized_name, description, is_system)
         VALUES (?, NULL, 'No Session Read', 'no session read', NULL, 0)`
      ).bind(roleId),
      env.DB.prepare("UPDATE user_role_assignments SET role_id = ?").bind(roleId),
    ]);
    expect((await SELF.fetch(API, { headers })).status).toBe(403);
  });

  it("returns bounded session-list continuation offsets", async () => {
    const headers = await externalHeaders();
    const store = new SessionIndexStore(env.DB);
    const now = Date.now();
    for (const [index, id] of ["list-oldest", "list-middle", "list-newest"].entries()) {
      await store.create({
        id,
        title: id,
        repoOwner: null,
        repoName: null,
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: null,
        baseBranch: null,
        status: "created",
        userId: USER_ID,
        createdAt: now + index,
        updatedAt: now + index,
      });
    }

    const first = await SELF.fetch(`${API}?limit=2&offset=0`, { headers });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      sessions: [{ id: "list-newest" }, { id: "list-middle" }],
      hasMore: true,
      continuationOffset: 2,
    });
    const second = await SELF.fetch(`${API}?limit=2&offset=2`, { headers });
    await expect(second.json()).resolves.toMatchObject({
      sessions: [{ id: "list-oldest" }],
      hasMore: false,
    });
    expect((await SELF.fetch(`${API}?limit=201`, { headers })).status).toBe(400);
  });

  it("denies suspended users", async () => {
    const headers = await externalHeaders();
    await env.DB.prepare("UPDATE users SET suspended_at = 1 WHERE id = ?").bind(USER_ID).run();
    const response = await SELF.fetch(API, { headers });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "active_user_required" });
  });

  it("rejects compound service:web and browser credentials on CLI-only routes", async () => {
    const response = await serviceFetch(API);
    expect(response.status).toBe(401);
  });

  it("uses Durable Object idempotency for strict text follow-ups", async () => {
    const headers = await externalHeaders();
    const created = await SELF.fetch(API, { method: "POST", headers, body: createBody() });
    const { sessionId } = (await created.json()) as { sessionId: string };
    for (const invalid of [
      { content: "Continue", clientRequestId: "invalid-1", attachments: [] },
      { content: "Continue", clientRequestId: "invalid-2", model: "unknown/model" },
      {
        content: "Continue",
        clientRequestId: "invalid-3",
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: "low",
      },
    ]) {
      expect(
        (
          await SELF.fetch(`${API}/${sessionId}/messages`, {
            method: "POST",
            headers,
            body: JSON.stringify(invalid),
          })
        ).status
      ).toBe(400);
    }
    const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
    expect((await queryDO(stub, "SELECT id FROM messages")).length).toBe(0);
    const body = JSON.stringify({
      content: "Continue",
      clientRequestId: "follow-up-1",
      model: "openai/gpt-5.6-sol",
      reasoningEffort: "high",
    });
    const first = await SELF.fetch(`${API}/${sessionId}/messages`, {
      method: "POST",
      headers,
      body,
    });
    const retry = await SELF.fetch(`${API}/${sessionId}/messages`, {
      method: "POST",
      headers,
      body,
    });
    expect(first.status).toBe(200);
    await expect(retry.json()).resolves.toEqual(await first.json());
    expect(
      (
        await SELF.fetch(`${API}/${sessionId}/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            content: "Changed",
            clientRequestId: "follow-up-1",
            model: "openai/gpt-5.6-sol",
            reasoningEffort: "high",
          }),
        })
      ).status
    ).toBe(409);
  });

  it("resolves reasoning-only follow-ups against the session model", async () => {
    const headers = await externalHeaders();
    const created = await SELF.fetch(API, { method: "POST", headers, body: createBody() });
    const { sessionId } = await created.json<{ sessionId: string }>();
    const before = await env.DB.prepare("SELECT updated_at FROM sessions WHERE id = ?")
      .bind(sessionId)
      .first<{ updated_at: number }>();

    const response = await SELF.fetch(`${API}/${sessionId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: "Reason more",
        clientRequestId: "reasoning-only",
        reasoningEffort: "xhigh",
      }),
    });
    expect(response.status).toBe(200);
    expect(
      (await env.DB.prepare("SELECT updated_at FROM sessions WHERE id = ?")
        .bind(sessionId)
        .first<{ updated_at: number }>())!.updated_at
    ).toBeGreaterThanOrEqual(before!.updated_at);
  });

  it("projects event snapshots conservatively and reports one-shot settled status", async () => {
    const headers = await externalHeaders();
    const created = await SELF.fetch(API, { method: "POST", headers, body: createBody() });
    const { sessionId } = (await created.json()) as { sessionId: string };
    const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
    const managedSecret = "managed-value-123";
    const secrets = new GlobalSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY!);
    await secrets.setSecrets({
      EXTERNAL_TEST_SECRET: managedSecret,
    });
    await seedEvents(stub, [
      {
        id: "event-1",
        type: "tool_call",
        messageId: "message-1",
        createdAt: 1,
        data: JSON.stringify({
          type: "tool_call",
          sandboxId: "sandbox-identity",
          timestamp: 1,
          messageId: "message-1",
          tool: "shell",
          callId: "call-1",
          args: { command: "safe", authorization: "Bearer credential" },
          accessToken: "credential",
        }),
      },
      {
        id: "event-2",
        type: "step_finish",
        messageId: "message-1",
        createdAt: 2,
        data: JSON.stringify({
          type: "step_finish",
          sandboxId: "sandbox-identity",
          timestamp: 2,
          messageId: "message-1",
          tokens: { input: 7, output: 3 },
          reason: `completed with ${managedSecret}`,
        }),
      },
    ]);
    await secrets.setSecrets({ EXTERNAL_TEST_SECRET: "rotated-value-456" });
    const events = await SELF.fetch(`${API}/${sessionId}/events`, { headers });
    expect(events.status).toBe(200);
    const eventBody = (await events.json()) as {
      changes: Array<{ kind: "upsert"; event: { data: Record<string, unknown> } }>;
    };
    const projectedEvents = eventBody.changes.map((change) => change.event);
    const toolCall = projectedEvents.find((event) => event.data.type === "tool_call");
    const stepFinish = projectedEvents.find((event) => event.data.type === "step_finish");
    expect(toolCall?.data).toEqual({ type: "tool_call", timestamp: 1 });
    expect(JSON.stringify(eventBody)).not.toContain("sandbox-identity");
    expect(JSON.stringify(eventBody)).not.toContain("Bearer credential");
    expect(stepFinish?.data.tokens).toEqual({ input: 7, output: 3 });
    expect(stepFinish?.data.reason).toBeUndefined();
    expect(JSON.stringify(eventBody)).not.toContain(managedSecret);
    expect(JSON.stringify(eventBody)).not.toContain("rotated-value-456");

    const waiting = await SELF.fetch(`${API}/${sessionId}/wait`, { headers });
    await expect(waiting.json()).resolves.toMatchObject({ status: "created", settled: false });
    await env.DB.prepare("UPDATE sessions SET status = 'completed' WHERE id = ?")
      .bind(sessionId)
      .run();
    const settled = await SELF.fetch(`${API}/${sessionId}/wait`, { headers });
    await expect(settled.json()).resolves.toMatchObject({ status: "completed", settled: true });
  });

  it("pages a snapshot checkpoint and resumes older-event updates without gaps", async () => {
    const headers = await externalHeaders();
    const created = await SELF.fetch(API, {
      method: "POST",
      headers,
      body: createBody({ idempotencyKey: "event-feed" }),
    });
    const { sessionId } = (await created.json()) as { sessionId: string };
    const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
    const eventData = (id: number, content = `event-${id}`) =>
      JSON.stringify({
        type: "token",
        sandboxId: "sandbox-1",
        timestamp: id,
        messageId: "message-1",
        content,
      });
    await seedEvents(
      stub,
      [3, 1, 2].map((id) => ({
        id: `event-${id}`,
        type: "token",
        messageId: "message-1",
        createdAt: id,
        data: eventData(id),
      }))
    );

    const first = (await (
      await SELF.fetch(`${API}/${sessionId}/events?limit=2`, { headers })
    ).json()) as {
      changes: Array<{ kind: "upsert"; revision: number; event: { id: string } }>;
      checkpoint: number;
      cursor: string;
      hasMore: boolean;
    };
    expect(first).toMatchObject({
      changes: [
        { kind: "upsert", event: { id: "event-1" }, revision: 2 },
        { kind: "upsert", event: { id: "event-2" }, revision: 3 },
      ],
      checkpoint: 3,
      hasMore: true,
    });

    await updateEventData(stub, "event-1", eventData(1, "updated older event"));
    await seedEvents(stub, [
      {
        id: "event-4",
        type: "token",
        messageId: "message-1",
        createdAt: 4,
        data: eventData(4),
      },
    ]);
    await deleteEvent(stub, "event-3");

    const continuation = (await (
      await SELF.fetch(`${API}/${sessionId}/events?cursor=${encodeURIComponent(first.cursor)}`, {
        headers,
      })
    ).json()) as {
      changes: Array<{ kind: "upsert"; event: { id: string } }>;
      checkpoint: number;
      hasMore: boolean;
    };
    expect(continuation).toMatchObject({
      changes: [{ kind: "upsert", event: { id: "event-3" }, revision: 1 }],
      checkpoint: 3,
      hasMore: false,
    });

    const resumed = (await (
      await SELF.fetch(`${API}/${sessionId}/events?after=${continuation.checkpoint}`, { headers })
    ).json()) as {
      changes: Array<{
        kind: "upsert";
        revision: number;
        event: { id: string; data: { content: string } };
      }>;
      checkpoint: number;
      hasMore: boolean;
    };
    expect(resumed).toMatchObject({
      changes: [
        {
          kind: "upsert",
          revision: 4,
          event: { id: "event-1" },
        },
        { kind: "upsert", revision: 5, event: { id: "event-4" } },
        { kind: "delete", revision: 6, eventId: "event-3" },
      ],
      checkpoint: 6,
      hasMore: false,
    });

    await updateEventData(stub, "event-1", eventData(1, "second update"));
    await updateEventData(stub, "event-1", eventData(1, "third update"));
    await deleteEvent(stub, "event-2");
    await renameEvent(stub, "event-4", "event-4-renamed");
    const later = (await (
      await SELF.fetch(`${API}/${sessionId}/events?after=5`, { headers })
    ).json()) as { changes: unknown[]; checkpoint: number };
    expect(later).toMatchObject({
      checkpoint: 11,
      changes: [
        { kind: "delete", revision: 6, eventId: "event-3" },
        {
          kind: "upsert",
          revision: 7,
          event: { id: "event-1" },
        },
        {
          kind: "upsert",
          revision: 8,
          event: { id: "event-1" },
        },
        { kind: "delete", revision: 9, eventId: "event-2" },
        { kind: "delete", revision: 10, eventId: "event-4" },
        { kind: "upsert", revision: 11, event: { id: "event-4-renamed" } },
      ],
    });

    const parsedCursor = parseEventChangeCursor(first.cursor)!;
    const futureCursor = encodeEventChangeCursor({ ...parsedCursor, checkpoint: 999 });
    expect(
      (
        await SELF.fetch(`${API}/${sessionId}/events?cursor=${encodeURIComponent(futureCursor)}`, {
          headers,
        })
      ).status
    ).toBe(400);

    const otherCreated = await SELF.fetch(API, {
      method: "POST",
      headers,
      body: createBody({ idempotencyKey: "foreign-cursor" }),
    });
    const { sessionId: otherSessionId } = (await otherCreated.json()) as { sessionId: string };
    expect(
      (
        await SELF.fetch(
          `${API}/${otherSessionId}/events?cursor=${encodeURIComponent(first.cursor)}`,
          { headers }
        )
      ).status
    ).toBe(400);
  });

  it("does not decrypt global secrets for an empty event change page", async () => {
    const headers = await externalHeaders();
    const created = await SELF.fetch(API, {
      method: "POST",
      headers,
      body: createBody({ idempotencyKey: "empty-events" }),
    });
    const { sessionId } = (await created.json()) as { sessionId: string };
    await env.DB.prepare(
      `INSERT INTO global_secrets (key, encrypted_value, created_at, updated_at)
       VALUES ('BROKEN', 'not-ciphertext', 1, 1)`
    ).run();

    const response = await SELF.fetch(`${API}/${sessionId}/events`, { headers });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      changes: [],
      checkpoint: 0,
      hasMore: false,
    });
  });

  it("returns an explicit error for an expired event checkpoint", async () => {
    const headers = await externalHeaders();
    const created = await SELF.fetch(API, {
      method: "POST",
      headers,
      body: createBody({ idempotencyKey: "expired-events" }),
    });
    const { sessionId } = (await created.json()) as { sessionId: string };
    const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
    await queryDO(
      stub,
      "UPDATE event_feed_state SET current_revision = 2, retention_floor = 2 WHERE singleton = 1"
    );

    const response = await SELF.fetch(`${API}/${sessionId}/events?after=1`, { headers });

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({
      error: "Event checkpoint expired",
      code: "event_checkpoint_expired",
    });
  });
});
