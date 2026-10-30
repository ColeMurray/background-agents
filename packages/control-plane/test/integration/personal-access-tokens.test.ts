/**
 * Personal access tokens against real D1: issuing, listing, and revoking through the human-only
 * routes, and authenticating a token through the deployed Worker. No production route accepts
 * tokens yet, so a token's reach here is exactly the refusals; admission on an opted-in route is
 * covered by the route admission matrix and the admission unit tests.
 */

import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isPersonalAccessTokenFormat,
  PERSONAL_ACCESS_TOKEN_MAX_PER_USER,
  type CreatedPersonalAccessToken,
  type ListPersonalAccessTokensResponse,
} from "@open-inspect/shared/types/personal-access-tokens";
import type { BuiltInRoleKey } from "@open-inspect/shared/rbac";
import { hashToken } from "../../src/auth/crypto";
import {
  LAST_USED_RESOLUTION_MS,
  PersonalAccessTokenStore,
} from "../../src/db/personal-access-tokens";
import { cleanD1Tables } from "./cleanup";
import { routeRequest, seedActiveUser, serviceFetch } from "./helpers";

const BASE = "https://cp.test";
const MEMBER = { userId: "22222222222222222222222222222222", role: "member" } as const;
const OTHER_MEMBER = { userId: "33333333333333333333333333333333", role: "member" } as const;
const VIEWER = { userId: "44444444444444444444444444444444", role: "viewer" } as const;
const OWNER = { userId: "55555555555555555555555555555555", role: "owner" } as const;
const DAY_MS = 24 * 60 * 60 * 1000;

type As = { userId: string; role: BuiltInRoleKey };

function issue(as: As, body: Record<string, unknown>): Promise<Response> {
  return serviceFetch(`${BASE}/personal-access-tokens`, {
    method: "POST",
    body: JSON.stringify(body),
    as,
  });
}

async function issued(as: As, permissions: string[] = ["sessions.read"]) {
  const response = await issue(as, { name: "laptop", permissions, expiresInDays: 30 });
  expect(response.status).toBe(201);
  return response.json<CreatedPersonalAccessToken>();
}

function withToken(path: string, token: string, method = "GET"): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
}

async function auditRows(action: string) {
  const { results } = await env.DB.prepare(
    `SELECT principal_kind, actor_user_id_snapshot, resource_type, resource_id,
            target_user_id_snapshot, operation_result, metadata_json
       FROM authorization_audit_events WHERE action = ? ORDER BY occurred_at`
  )
    .bind(action)
    .all<{
      principal_kind: string;
      actor_user_id_snapshot: string | null;
      resource_type: string;
      resource_id: string | null;
      target_user_id_snapshot: string | null;
      operation_result: string;
      metadata_json: string;
    }>();
  return results;
}

beforeEach(cleanD1Tables);
afterEach(cleanD1Tables);

describe("issuing personal access tokens", () => {
  it("returns the secret once, lists the token without it, and audits the issue", async () => {
    const before = Date.now();
    const response = await issue(MEMBER, {
      name: " laptop ",
      permissions: ["automations.create", "sessions.read", "sessions.read"],
      expiresInDays: 30,
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const created = await response.json<CreatedPersonalAccessToken>();
    expect(isPersonalAccessTokenFormat(created.token)).toBe(true);
    expect(created).toMatchObject({
      name: "laptop",
      permissions: ["automations.create", "sessions.read"],
      lastUsedAt: null,
    });
    expect(created.token.startsWith(created.displayPrefix)).toBe(true);
    expect(created.expiresAt).toBeGreaterThanOrEqual(before + 30 * DAY_MS);
    expect(created.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * DAY_MS);

    const list = await serviceFetch(`${BASE}/personal-access-tokens`, { as: MEMBER });
    expect(list.status).toBe(200);
    expect(list.headers.get("Cache-Control")).toBe("private, no-store");
    const { token: _secret, ...listed } = created;
    await expect(list.json()).resolves.toEqual({ tokens: [listed] });

    const stored = await env.DB.prepare(
      "SELECT token_hash FROM personal_access_tokens WHERE id = ?"
    )
      .bind(created.id)
      .first<{ token_hash: string }>();
    expect(stored?.token_hash).toBe(await hashToken(created.token));

    const [audit] = await auditRows("personal_access_token.created");
    expect(audit).toMatchObject({
      principal_kind: "user",
      actor_user_id_snapshot: MEMBER.userId,
      resource_type: "personal_access_token",
      resource_id: created.id,
      target_user_id_snapshot: MEMBER.userId,
      operation_result: "applied",
    });
    expect(audit?.metadata_json).not.toContain(created.token);
    expect(JSON.parse(audit!.metadata_json)).toEqual({
      before: {},
      requested: {},
      after: {
        name: "laptop",
        displayPrefix: created.displayPrefix,
        permissions: ["automations.create", "sessions.read"],
        expiresAt: created.expiresAt,
      },
    });
  });

  it("lists only the caller's own tokens", async () => {
    await issued(MEMBER);
    await issued(OTHER_MEMBER);
    const list = await serviceFetch(`${BASE}/personal-access-tokens`, { as: OTHER_MEMBER });
    const { tokens } = await list.json<ListPersonalAccessTokensResponse>();
    expect(tokens).toHaveLength(1);
  });

  it("refuses to grant a permission the issuer does not hold", async () => {
    const response = await issue(VIEWER, {
      name: "laptop",
      permissions: ["sessions.read", "automations.create"],
      expiresInDays: 30,
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "permission_not_held",
      permission: "automations.create",
    });
    const { results } = await env.DB.prepare("SELECT id FROM personal_access_tokens").all();
    expect(results).toEqual([]);
  });

  it("refuses to grant a permission withheld from tokens, even to an Owner", async () => {
    const response = await issue(OWNER, {
      name: "laptop",
      permissions: ["global_secrets.manage"],
      expiresInDays: 30,
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "permission_not_grantable",
      permission: "global_secrets.manage",
    });
  });

  it.each([
    ["without an expiry", { name: "laptop", permissions: ["sessions.read"] }],
    ["with an empty grant", { name: "laptop", permissions: [], expiresInDays: 30 }],
  ])("refuses a request %s", async (_label, body) => {
    expect((await issue(MEMBER, body)).status).toBe(400);
  });

  it("caps how many tokens one user holds", async () => {
    await issued(MEMBER);
    const store = new PersonalAccessTokenStore(env.DB);
    for (let index = 1; index < PERSONAL_ACCESS_TOKEN_MAX_PER_USER; index++) {
      const result = await store.issue({
        userId: MEMBER.userId,
        name: `token-${index}`,
        permissions: ["sessions.read"],
        expiresAt: Date.now() + DAY_MS,
        now: Date.now(),
        requestId: `request-${index}`,
      });
      expect(result.kind).toBe("issued");
    }
    const response = await issue(MEMBER, {
      name: "one too many",
      permissions: ["sessions.read"],
      expiresInDays: 30,
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "personal_access_token_limit_reached",
    });
    expect(await auditRows("personal_access_token.created")).toHaveLength(
      PERSONAL_ACCESS_TOKEN_MAX_PER_USER
    );
  });
});

describe("revoking personal access tokens", () => {
  it("revokes only the caller's own token, audits it, and stops it authenticating", async () => {
    const created = await issued(MEMBER);
    const path = `${BASE}/personal-access-tokens/${created.id}`;

    expect((await serviceFetch(path, { method: "DELETE", as: OTHER_MEMBER })).status).toBe(404);
    const revoked = await serviceFetch(path, { method: "DELETE", as: MEMBER });
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toEqual({ revoked: true });
    expect((await serviceFetch(path, { method: "DELETE", as: MEMBER })).status).toBe(404);

    const audits = await auditRows("personal_access_token.revoked");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_user_id_snapshot: MEMBER.userId,
      target_user_id_snapshot: MEMBER.userId,
      resource_id: created.id,
    });
    expect(JSON.parse(audits[0]!.metadata_json)).toMatchObject({
      before: { name: "laptop", permissions: ["sessions.read"] },
      after: {},
    });
    const grants = await env.DB.prepare(
      "SELECT permission_id FROM personal_access_token_permissions WHERE token_id = ?"
    )
      .bind(created.id)
      .all();
    expect(grants.results).toEqual([]);
    expect((await withToken("/sessions", created.token)).status).toBe(401);
  });

  it("deletes a user's tokens and grants with the user", async () => {
    const userId = "66666666666666666666666666666666";
    await seedActiveUser(userId);
    const result = await new PersonalAccessTokenStore(env.DB).issue({
      userId,
      name: "laptop",
      permissions: ["sessions.read"],
      expiresAt: Date.now() + DAY_MS,
      now: Date.now(),
      requestId: "request-1",
    });
    expect(result.kind).toBe("issued");
    // The default role assignment restricts user deletion, as a member merge also clears it first.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM user_role_assignments WHERE user_id = ?").bind(userId),
      env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
    ]);
    const remaining = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM personal_access_tokens) AS tokens,
              (SELECT COUNT(*) FROM personal_access_token_permissions) AS grants`
    ).first();
    expect(remaining).toEqual({ tokens: 0, grants: 0 });
  });
});

describe("authenticating with a personal access token", () => {
  it.each([
    ["GET", "/personal-access-tokens"],
    ["POST", "/personal-access-tokens"],
    ["DELETE", "/personal-access-tokens/any"],
  ])("can never manage tokens: %s %s", async (method, path) => {
    const created = await issued(OWNER);
    const response = await withToken(path, created.token, method);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "personal_access_token_not_accepted",
    });
  });

  it("is refused where the route does not accept tokens, and the refusal names the token", async () => {
    const created = await issued(MEMBER);
    const response = await withToken("/sessions", created.token);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "personal_access_token_not_accepted",
    });

    const denials = await auditRows("authorization.request_denied");
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({
      principal_kind: "personal-access-token",
      actor_user_id_snapshot: MEMBER.userId,
    });
    expect(JSON.parse(denials[0]!.metadata_json)).toMatchObject({
      personalAccessTokenId: created.id,
      responseCode: "personal_access_token_not_accepted",
    });

    // The audit log reads token-attributed rows back through the shared contract.
    const events = await serviceFetch(`${BASE}/audit-events`, { as: OWNER });
    expect(events.status).toBe(200);
    const body = await events.json<{ events: { principalKind: string }[] }>();
    expect(body.events.map((event) => event.principalKind)).toContain("personal-access-token");
  });

  it("answers an expired token as unauthenticated", async () => {
    const created = await issued(MEMBER);
    await env.DB.prepare("UPDATE personal_access_tokens SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, created.id)
      .run();
    expect((await withToken("/sessions", created.token)).status).toBe(401);
  });

  it("answers a well-formed unknown token as unauthenticated", async () => {
    const created = await issued(MEMBER);
    const unknown = `${created.token.slice(0, -4)}0000`;
    expect((await withToken("/sessions", unknown)).status).toBe(401);
  });

  it("records last use at most once per resolution window", async () => {
    const created = await issued(MEMBER);
    const present = async () => {
      const executionCtx = createExecutionContext();
      await routeRequest(
        new Request(`${BASE}/sessions`, { headers: { Authorization: `Bearer ${created.token}` } }),
        env,
        executionCtx
      );
      await waitOnExecutionContext(executionCtx);
    };
    const lastUsed = async () =>
      (
        await env.DB.prepare("SELECT last_used_at FROM personal_access_tokens WHERE id = ?")
          .bind(created.id)
          .first<{ last_used_at: number | null }>()
      )?.last_used_at;
    const setLastUsed = (at: number) =>
      env.DB.prepare("UPDATE personal_access_tokens SET last_used_at = ? WHERE id = ?")
        .bind(at, created.id)
        .run();

    const before = Date.now();
    await present();
    expect(await lastUsed()).toBeGreaterThanOrEqual(before);

    const recent = Date.now() - LAST_USED_RESOLUTION_MS / 2;
    await setLastUsed(recent);
    await present();
    expect(await lastUsed()).toBe(recent);

    const stale = Date.now() - LAST_USED_RESOLUTION_MS * 2;
    await setLastUsed(stale);
    await present();
    expect(await lastUsed()).toBeGreaterThan(stale + LAST_USED_RESOLUTION_MS);
  });
});
