import { beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { ACCESS_TOKEN_PREFIX } from "@open-inspect/shared/types/access-tokens";
import {
  LAST_USED_RESOLUTION_MS,
  PersonalAccessTokenStore,
} from "../../src/db/personal-access-tokens";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch, sqlDatabase } from "./helpers";

const USER_ID = "11111111111111111111111111111111";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

async function seedUser(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, email, email_verified, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?)`
  )
    .bind(USER_ID, "operator@example.com", Date.now(), Date.now())
    .run();
}

async function setLastUsed(at: number): Promise<void> {
  await env.DB.prepare("UPDATE personal_access_tokens SET last_used_at = ? WHERE user_id = ?")
    .bind(at, USER_ID)
    .run();
}

async function readLastUsed(): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT last_used_at FROM personal_access_tokens WHERE user_id = ?"
  )
    .bind(USER_ID)
    .first<{ last_used_at: number | null }>();
  return row?.last_used_at ?? null;
}

async function issueToken(expiresAt: number | null = null): Promise<string> {
  const created = await new PersonalAccessTokenStore(sqlDatabase(env.DB)).create({
    userId: USER_ID,
    name: "laptop",
    expiresAt,
  });
  return created.token;
}

function bearer(token: string, init?: { method?: string }): Promise<Response> {
  return SELF.fetch("https://test.local/sessions", {
    method: init?.method ?? "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe("personal access tokens", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedUser();
  });

  it("authenticates a read as the user who issued the token", async () => {
    const response = await bearer(await issueToken());
    expect(response.status).toBe(200);
  });

  it("carries its owner's authorization, not a bypass of it", async () => {
    // The default role reads sessions but not integration settings. Both
    // routes accept a user-or-service principal, so the difference is the
    // permission and nothing else — a principal kind that loaded no subject
    // would be admitted to both.
    const token = await issueToken();
    expect(await bearer(token)).toMatchObject({ status: 200 });

    const denied = await SELF.fetch("https://test.local/integration-settings/github/repos", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      code: "permission_required",
      permission: "integrations.read",
    });
  });

  it("stops working when its owner is suspended", async () => {
    // Revoking the person has to revoke their tokens, without anyone having
    // to enumerate them.
    const token = await issueToken();
    await env.DB.prepare("UPDATE users SET suspended_at = ? WHERE id = ?")
      .bind(Date.now(), USER_ID)
      .run();

    const response = await bearer(token);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "active_user_required" });
  });

  it("refuses every mutating method, whatever the route policy allows", async () => {
    // Real routes, each accepting a user-or-service principal: a 403 here is
    // the read-only rule and not a 404 from an unmatched path.
    const mutations = [
      ["POST", "https://test.local/skills"],
      ["PUT", "https://test.local/keyboard-shortcuts"],
      ["PATCH", "https://test.local/sessions/any/read-state"],
      ["DELETE", "https://test.local/sessions/any"],
    ] as const;

    const token = await issueToken();
    for (const [method, url] of mutations) {
      const response = await SELF.fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status, method).toBe(403);
    }
  });

  it("cannot mint another token, so revocation stays meaningful", async () => {
    // /access-tokens is human-only. A token that could issue itself a
    // successor would survive its own revocation.
    const token = await issueToken();
    const response = await SELF.fetch("https://test.local/access-tokens", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(403);
  });

  it("rejects an expired token", async () => {
    const response = await bearer(await issueToken(Date.now() - MS_PER_DAY));
    expect(response.status).toBe(401);
  });

  it("rejects a token that was revoked", async () => {
    const store = new PersonalAccessTokenStore(sqlDatabase(env.DB));
    const created = await store.create({ userId: USER_ID, name: "laptop", expiresAt: null });
    expect(await store.revoke(USER_ID, created.id)).toBe(true);

    const response = await bearer(created.token);
    expect(response.status).toBe(401);
  });

  it("rejects an unknown token that is nonetheless well formed", async () => {
    const response = await bearer(`${ACCESS_TOKEN_PREFIX}${"0".repeat(64)}`);
    expect(response.status).toBe(401);
  });

  it("stores only a hash, so the table cannot yield a working credential", async () => {
    const token = await issueToken();
    const row = await env.DB.prepare(
      "SELECT token_hash, display_prefix FROM personal_access_tokens WHERE user_id = ?"
    )
      .bind(USER_ID)
      .first<{ token_hash: string; display_prefix: string }>();

    expect(row?.token_hash).not.toBe(token);
    expect(token).not.toContain(row?.token_hash);
    expect(token.startsWith(row?.display_prefix ?? "x")).toBe(true);
  });

  it("records last use, so an unused token is identifiable before revoking it", async () => {
    const token = await issueToken();
    expect(await bearer(token)).toMatchObject({ status: 200 });

    expect(await readLastUsed()).toBeGreaterThan(0);
  });

  it("does not rewrite last use on every read", async () => {
    // Otherwise each read bills a D1 write, and a polling MCP client turns the
    // read-only path into sustained write load.
    const token = await issueToken();

    // A column older than the resolution window must be written. That pins the
    // bookkeeping write as observable by the time the response resolves —
    // without it, the unchanged value below would prove nothing.
    const stale = Date.now() - 5 * LAST_USED_RESOLUTION_MS;
    await setLastUsed(stale);
    await bearer(token);
    expect(await readLastUsed()).not.toBe(stale);

    // Seeded rather than reused from the write above: two requests can land in
    // the same millisecond, and an implementation that writes on every read
    // would then leave the same value behind and pass anyway.
    const recent = Date.now() - 1_000;
    await setLastUsed(recent);
    await bearer(token);
    expect(await readLastUsed()).toBe(recent);
  });

  it("reads as its owner, so createdBy=me resolves to the issuing user", async () => {
    const token = await issueToken();
    const response = await SELF.fetch("https://test.local/sessions?createdBy=me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
  });

  it("keeps the plaintext token and the listing out of caches", async () => {
    const created = await serviceFetch("https://test.local/access-tokens", {
      method: "POST",
      body: JSON.stringify({ name: "laptop" }),
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("Cache-Control")).toBe("private, no-store");

    // The listing names a user's credentials and when each was last used, so
    // it is no more cacheable than the token itself.
    const listed = await serviceFetch("https://test.local/access-tokens");
    expect(listed.status).toBe(200);
    expect(listed.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("lists and revokes through the human-only routes", async () => {
    const created = await serviceFetch("https://test.local/access-tokens", {
      method: "POST",
      body: JSON.stringify({ name: "laptop" }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; token: string; displayPrefix: string };
    expect(body.token.startsWith(ACCESS_TOKEN_PREFIX)).toBe(true);

    const listed = await serviceFetch("https://test.local/access-tokens");
    const list = (await listed.json()) as { tokens: { id: string; token?: string }[] };
    expect(list.tokens).toHaveLength(1);
    // The plaintext is returned by creation and never again.
    expect(list.tokens[0].token).toBeUndefined();

    const revoked = await serviceFetch(`https://test.local/access-tokens/${body.id}`, {
      method: "DELETE",
    });
    expect(revoked.status).toBe(200);
    await expect(bearer(body.token)).resolves.toMatchObject({ status: 401 });
  });
});
