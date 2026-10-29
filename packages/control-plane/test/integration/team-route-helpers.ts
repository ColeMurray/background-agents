import { createExecutionContext, env } from "cloudflare:test";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import { cleanD1Tables } from "./cleanup";
import { routeRequest, seedActiveUser, serviceFetch, serviceRequestHeaders } from "./helpers";

export const BASE = "https://test.local";
export const OWNER = "11111111111111111111111111111111";
export const MEMBER = "22222222222222222222222222222222";
export const OTHER = "33333333333333333333333333333333";

export async function request(path: string, method = "GET", body?: object) {
  return serviceFetch(`${BASE}${path}`, {
    method,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

export async function setRole(
  userId: string,
  role: "owner" | "administrator" | "member" | "viewer"
) {
  await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
    .bind(BUILT_IN_ROLE_REGISTRY[role].id, userId)
    .run();
}

export async function auditEvents(teamId: string) {
  const result = await env.DB.prepare(
    "SELECT action, team_id, target_user_id_snapshot, metadata_json FROM authorization_audit_events WHERE resource_type = 'team' AND team_id = ? ORDER BY occurred_at, id"
  )
    .bind(teamId)
    .all();
  return result.results;
}

export async function requestAuditEvents(response: Response) {
  const result = await env.DB.prepare(
    "SELECT action FROM authorization_audit_events WHERE request_id = ? ORDER BY action"
  )
    .bind(response.headers.get("x-request-id"))
    .all();
  return result.results;
}

export async function modeRequest(
  path: string,
  mode: "off" | "shadow" | "on",
  role: "owner" | "administrator" | "member" | "viewer" = "member"
) {
  const url = `${BASE}${path}`;
  const headers = await serviceRequestHeaders(url, { as: { userId: OWNER, role } });
  return routeRequest(
    new Request(url, { headers }),
    { ...env, TEAMS_ENFORCEMENT: mode },
    createExecutionContext()
  );
}

export async function setupTeamRoutes() {
  await cleanD1Tables();
  await seedActiveUser(MEMBER);
  await seedActiveUser(OTHER);
  await request("/me/authorization");
}
