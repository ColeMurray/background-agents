import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

const USER_ID = "11111111111111111111111111111111";
const PATH = "/operator/sessions/archive";

async function archive(): Promise<Response> {
  return serviceFetch(`https://cp.test${PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    initialUserRole: "member",
  });
}

describe("operator archive authorization", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  it("records a permission denial, not an allowed request, for a member", async () => {
    const response = await archive();
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "permission_required",
      permission: "sessions.archive_any",
    });
    const audit = await env.DB.prepare(
      `SELECT action, operation_result FROM authorization_audit_events
       WHERE resource_id = ?`
    )
      .bind(PATH)
      .all();
    expect(audit.results).toEqual([
      { action: "authorization.request_denied", operation_result: "denied" },
    ]);
  });

  it("grants and revokes archive access through the current role assignment", async () => {
    expect((await archive()).status).toBe(403);
    await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
      .bind("role_builtin_administrator", USER_ID)
      .run();

    const allowed = await archive();
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({
      archivedIds: [],
      failed: [],
      hasMore: false,
      nextCursor: null,
    });

    await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
      .bind("role_builtin_member", USER_ID)
      .run();
    expect((await archive()).status).toBe(403);
  });
});
