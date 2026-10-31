import { createExecutionContext, env } from "cloudflare:test";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import type { WorkerBindings } from "../../src/cloudflare/platform";
import { mergeUsers } from "../../src/db/user-merge";
import { cleanD1Tables } from "./cleanup";
import { initSession, serviceFetch, serviceRequestHeaders } from "./helpers";
import { insertCanonicalUser } from "./identity-seed-helpers";

/**
 * The export service end to end: real routes, real D1, real signatures. The
 * integration bindings pin it to EXPORT_USER's GitHub identity.
 */

const BASE = "https://test.local";
const EXPORT_USER = env.SERVICE_AUTH_EXPORT_USER_ID!;
const EXPORT_ACTOR = env.SERVICE_AUTH_EXPORT_ACTOR!;
const OTHER_USER = "77777777777777777777777777777777";

async function seedUser(userId: string, role: "owner" | "viewer"): Promise<void> {
  // Seeding a browser session creates the user and its `github:<userId>` identity.
  await serviceRequestHeaders(`${BASE}/me/authorization`, { as: { userId, role } });
}

/** `actor: null` signs without an actor header. */
function exportFetch(path: string, actor: string | null = EXPORT_ACTOR): Promise<Response> {
  return serviceFetch(`${BASE}${path}`, { service: "export", actor: actor ?? undefined });
}

async function fetchWithEnv(path: string, requestEnv: WorkerBindings): Promise<Response> {
  const url = `${BASE}${path}`;
  const headers = await serviceRequestHeaders(url, { service: "export", actor: EXPORT_ACTOR });
  return worker.fetch(new Request(url, { headers }), requestEnv, createExecutionContext());
}

describe("export service", () => {
  let sessionId = "";

  beforeEach(async () => {
    await cleanD1Tables();
    await seedUser(EXPORT_USER, "owner");
    sessionId = (await initSession({ userId: EXPORT_USER })).sessionName;
  });

  it("exports in bulk and by session as its pinned user", async () => {
    const bulk = await exportFetch("/sessions/export");
    expect(bulk.status).toBe(200);
    expect(bulk.headers.get("Content-Type")).toContain("application/x-ndjson");
    expect(await bulk.text()).toContain(sessionId);

    const single = await exportFetch(`/sessions/${sessionId}/export`);
    expect(single.status).toBe(200);
  });

  it("is refused on a route that does not opt it in", async () => {
    const response = await exportFetch("/sessions");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "service_capability_required" });
  });

  it("refuses any actor but the pinned one, or none", async () => {
    await seedUser(OTHER_USER, "owner");
    for (const actor of [`github:${OTHER_USER}`, null]) {
      expect((await exportFetch("/sessions/export", actor)).status, String(actor)).toBe(401);
    }
  });

  it("gets no more than its user: a Viewer cannot export", async () => {
    await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
      .bind(BUILT_IN_ROLE_REGISTRY.viewer.id, EXPORT_USER)
      .run();
    const response = await exportFetch("/sessions/export");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "permission_required" });
  });

  it("is refused while its user is suspended", async () => {
    await env.DB.prepare("UPDATE users SET suspended_at = ? WHERE id = ?")
      .bind(Date.now(), EXPORT_USER)
      .run();
    const response = await exportFetch("/sessions/export");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "active_user_required" });
  });

  it("stops working when its user is merged into another", async () => {
    await insertCanonicalUser({ id: OTHER_USER, email: "survivor@test.local", emailVerified: 1 });
    await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
      .bind(BUILT_IN_ROLE_REGISTRY.owner.id, OTHER_USER)
      .run();
    await mergeUsers(env.DB, { survivorId: OTHER_USER, loserId: EXPORT_USER });
    const moved = await env.DB.prepare(
      "SELECT user_id FROM user_identities WHERE provider = 'github' AND provider_user_id = ?"
    )
      .bind(EXPORT_USER)
      .first<{ user_id: string }>();
    expect(moved?.user_id).toBe(OTHER_USER);

    expect((await exportFetch("/sessions/export")).status).toBe(401);
  });

  it("answers 401, not 500, when it is not enabled", async () => {
    for (const unset of [
      "SERVICE_AUTH_SECRET_EXPORT",
      "SERVICE_AUTH_EXPORT_ACTOR",
      "SERVICE_AUTH_EXPORT_USER_ID",
    ] as const) {
      const response = await fetchWithEnv("/sessions/export", { ...env, [unset]: undefined });
      expect(response.status, unset).toBe(401);
    }
  });
});
