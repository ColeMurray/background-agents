import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionBatchArchiveResponseSchema } from "@open-inspect/shared/types/session-archive";
import { cleanD1Tables } from "./cleanup";
import { initSession, queryDO, seedMessage, serviceFetch, waitForSandboxStatus } from "./helpers";

const USER_ID = "11111111111111111111111111111111";
const URL = "https://cp.test/sessions/batch-archive";
const post = (sessionIds: string[]) =>
  serviceFetch(URL, {
    method: "POST",
    body: JSON.stringify({ sessionIds }),
    initialUserRole: "administrator",
  });

beforeEach(cleanD1Tables);
afterEach(cleanD1Tables);

describe("session batch archive", () => {
  it("denies anonymous and service callers", async () => {
    expect((await SELF.fetch(URL, { method: "POST", body: "{}" })).status).toBe(401);
    expect(
      (await serviceFetch(URL, { method: "POST", body: "{}", service: "slack-bot" })).status
    ).toBe(403);
  });

  it("audits member denial and grants/revokes bulk access using the current role", async () => {
    const member = () =>
      serviceFetch(URL, {
        method: "POST",
        body: JSON.stringify({ sessionIds: ["missing"] }),
        initialUserRole: "member",
      });
    expect((await member()).status).toBe(403);
    const audit = await env.DB.prepare(
      "SELECT action, operation_result FROM authorization_audit_events WHERE resource_id = ?"
    )
      .bind("/sessions/batch-archive")
      .all();
    expect(audit.results).toEqual([
      { action: "authorization.request_denied", operation_result: "denied" },
    ]);
    await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
      .bind("role_builtin_administrator", USER_ID)
      .run();
    const allowed = await member();
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({
      results: [{ sessionId: "missing", outcome: "not_found" }],
    });
    await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
      .bind("role_builtin_member", USER_ID)
      .run();
    expect((await member()).status).toBe(403);
  });

  it.each([
    {},
    { sessionIds: [] },
    { sessionIds: ["one", "one"] },
    { sessionIds: ["one"], userId: USER_ID },
    { cursor: "100:0:" },
  ])("rejects invalid selection without archiving anything: %j", async (body) => {
    const response = await serviceFetch(URL, { method: "POST", body: JSON.stringify(body) });
    expect(response.status).toBe(400);
  });

  it("uses the canonical archive operation, reports mixed outcomes, and supports targeted retries", async () => {
    const ready = await initSession({ userId: "other-owner" });
    const cancelled = await initSession();
    const queued = await initSession();
    for (const session of [ready, cancelled, queued])
      await waitForSandboxStatus(session.stub, "failed");
    await queryDO(cancelled.stub, "UPDATE session SET status = 'cancelled'");
    const [participant] = await queryDO<{ id: string }>(
      queued.stub,
      "SELECT id FROM participants LIMIT 1"
    );
    await seedMessage(queued.stub, {
      id: "pending",
      authorId: participant.id,
      content: "work",
      source: "web",
      status: "pending",
      createdAt: Date.now(),
    });
    const ids = [ready.sessionName, "missing", cancelled.sessionName, queued.sessionName];
    const response = await post(ids);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(sessionBatchArchiveResponseSchema.parse(await response.json())).toEqual({
      results: [
        { sessionId: ready.sessionName, outcome: "archived" },
        { sessionId: "missing", outcome: "not_found" },
        { sessionId: cancelled.sessionName, outcome: "skipped_cancelled" },
        { sessionId: queued.sessionName, outcome: "skipped_queued_work" },
      ],
    });
    expect(await (await post([ready.sessionName])).json()).toEqual({
      results: [{ sessionId: ready.sessionName, outcome: "already_archived" }],
    });
  });

  it.each(["active", "completed"])(
    "repairs a stale %s projection without rewriting activity",
    async (status) => {
      const { stub, sessionName } = await initSession();
      await waitForSandboxStatus(stub, "failed");
      expect(
        (await stub.fetch("http://internal/internal/archive", { method: "POST" })).status
      ).toBe(200);
      const touchedAt = Date.now() + 60_000;
      await env.DB.prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?")
        .bind(status, touchedAt, sessionName)
        .run();
      const response = await post([sessionName]);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        results: [{ sessionId: sessionName, outcome: "already_archived" }],
      });
      expect(
        await env.DB.prepare("SELECT status, updated_at FROM sessions WHERE id = ?")
          .bind(sessionName)
          .first()
      ).toEqual({ status: "archived", updated_at: touchedAt });
    }
  );

  it("does not report successful archiving when the index row is missing", async () => {
    const { stub, sessionName } = await initSession();
    await waitForSandboxStatus(stub, "failed");
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionName).run();
    expect(await (await post([sessionName])).json()).toEqual({
      results: [{ sessionId: sessionName, outcome: "failed" }],
    });
  });

  it("keeps ordinary single-session archiving available to non-participant members", async () => {
    const { stub, sessionName } = await initSession({ userId: "other-owner" });
    await waitForSandboxStatus(stub, "failed");
    const participants = await queryDO<{ user_id: string }>(
      stub,
      "SELECT user_id FROM participants"
    );
    expect(participants.map((p) => p.user_id)).not.toContain(USER_ID);
    const response = await serviceFetch(`https://cp.test/sessions/${sessionName}/archive`, {
      method: "POST",
      body: "{}",
      initialUserRole: "member",
    });
    expect(response.status).toBe(200);
  });
});
