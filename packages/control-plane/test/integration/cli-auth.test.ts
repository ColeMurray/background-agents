import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cliDeviceAuthorizationExchangeResponseSchema,
  cliMeResponseSchema,
  pendingCliDeviceAuthorizationResponseSchema,
  startCliDeviceAuthorizationResponseSchema,
} from "@open-inspect/shared/types/cli-auth";
import { cleanD1Tables } from "./cleanup";
import { hashToken } from "../../src/auth/crypto";
import {
  CLI_CREDENTIAL_RETENTION_MS,
  CLI_DEVICE_ATTEMPT_RETENTION_MS,
} from "../../src/cli-auth/device-authorization-service";
import { CLI_AUTH_RATE_LIMITS } from "../../src/routes/cli-auth";
import { serviceFetch } from "./helpers";

const API = "https://cp.test/external/v1/cli";

async function start() {
  const response = await SELF.fetch(`${API}/device-authorizations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceName: "integration laptop" }),
  });
  expect(response.status).toBe(201);
  return startCliDeviceAuthorizationResponseSchema.parse(await response.json());
}

async function exchange(deviceSecret: string): Promise<Response> {
  return SELF.fetch(`${API}/device-authorizations/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceSecret }),
  });
}

async function revokeIssued(deviceSecret: string): Promise<Response> {
  return SELF.fetch(`${API}/device-authorizations/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceSecret }),
  });
}

async function approve(userCode: string): Promise<Response> {
  return serviceFetch(`${API}/device-authorizations/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userCode }),
  });
}

async function pending(userCode: string): Promise<Response> {
  return serviceFetch(
    `${API}/device-authorizations/pending?user_code=${encodeURIComponent(userCode)}`
  );
}

describe("external v1 CLI authentication", () => {
  beforeEach(cleanD1Tables);
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanD1Tables();
  });

  it("stores hashes only and atomically issues one 30-day user credential", async () => {
    const started = await start();
    expect(started.deviceSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(started.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(started.expiresAt - Date.now()).toBeGreaterThan(9 * 60 * 1000);
    expect(started.expiresAt - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);

    const storedAttempt = await env.DB.prepare(
      "SELECT * FROM cli_device_authorization_attempts"
    ).first<Record<string, unknown>>();
    expect(storedAttempt).toMatchObject({ device_name: "integration laptop" });
    expect(Object.values(storedAttempt!)).not.toContain(started.deviceSecret);
    expect(Object.values(storedAttempt!)).not.toContain(started.userCode);

    const pendingDetails = await pending(started.userCode.toLowerCase());
    expect(pendingDetails.status).toBe(200);
    expect(pendingCliDeviceAuthorizationResponseSchema.parse(await pendingDetails.json())).toEqual({
      deviceName: "integration laptop",
      expiresAt: started.expiresAt,
    });

    const pendingExchange = await exchange(started.deviceSecret);
    expect(pendingExchange.status).toBe(202);
    expect(
      cliDeviceAuthorizationExchangeResponseSchema.parse(await pendingExchange.json())
    ).toMatchObject({
      status: "pending",
    });

    expect((await approve(started.userCode.toLowerCase())).status).toBe(204);
    expect((await pending(started.userCode)).status).toBe(409);

    // Isolate the atomic exchange race from the independently tested polling backoff.
    await env.DB.prepare("DELETE FROM cli_auth_rate_limits WHERE rate_key = ?")
      .bind(`exchange-secret-burst:${await hashToken(started.deviceSecret)}`)
      .run();

    const exchanges = await Promise.all([
      exchange(started.deviceSecret),
      exchange(started.deviceSecret),
    ]);
    expect(exchanges.map((response) => response.status).sort()).toEqual([200, 410]);
    const winner = exchanges.find((response) => response.status === 200)!;
    const issued = cliDeviceAuthorizationExchangeResponseSchema.parse(await winner.json());
    expect(issued.status).toBe("authorized");
    if (issued.status !== "authorized") throw new Error("Expected authorized exchange");
    expect(issued.expiresAt - Date.now()).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);

    const storedCredential = await env.DB.prepare("SELECT * FROM cli_credentials").first<
      Record<string, unknown>
    >();
    expect(Object.values(storedCredential!)).not.toContain(issued.credential);
    expect(storedCredential).toMatchObject({ user_id: "11111111111111111111111111111111" });

    const me = await SELF.fetch(`${API}/me`, {
      headers: { Authorization: `Bearer ${issued.credential}` },
    });
    expect(me.status).toBe(200);
    expect(cliMeResponseSchema.parse(await me.json())).toMatchObject({
      installation: { name: "integration-test" },
      user: { id: "11111111111111111111111111111111" },
      credential: { id: issued.credentialId, expiresAt: issued.expiresAt },
    });

    const internalBrowserRoute = await SELF.fetch("https://cp.test/sessions", {
      headers: { Authorization: `Bearer ${issued.credential}` },
    });
    expect(internalBrowserRoute.status).toBe(401);
  });

  it("denies suspended and missing-role users through current RBAC policy", async () => {
    const started = await start();
    expect((await approve(started.userCode)).status).toBe(204);
    const response = await exchange(started.deviceSecret);
    const issued = cliDeviceAuthorizationExchangeResponseSchema.parse(await response.json());
    if (issued.status !== "authorized") throw new Error("Expected authorized exchange");
    const authorization = { Authorization: `Bearer ${issued.credential}` };

    await env.DB.prepare("UPDATE users SET suspended_at = 1").run();
    const suspended = await SELF.fetch(`${API}/me`, { headers: authorization });
    expect(suspended.status).toBe(403);
    await expect(suspended.json()).resolves.toMatchObject({ code: "active_user_required" });

    await env.DB.prepare("UPDATE users SET suspended_at = NULL").run();
    await env.DB.prepare("DELETE FROM user_role_assignments").run();
    const unassigned = await SELF.fetch(`${API}/me`, { headers: authorization });
    expect(unassigned.status).toBe(403);
    await expect(unassigned.json()).resolves.toMatchObject({ code: "assignment_required" });
  });

  it("fails closed for expired attempts, expired credentials, and revocation", async () => {
    const expiredAttempt = await start();
    await env.DB.prepare("UPDATE cli_device_authorization_attempts SET expires_at = 1").run();
    expect((await pending(expiredAttempt.userCode)).status).toBe(410);
    expect((await approve(expiredAttempt.userCode)).status).toBe(410);
    expect((await exchange(expiredAttempt.deviceSecret)).status).toBe(410);

    const started = await start();
    expect((await approve(started.userCode)).status).toBe(204);
    const issuedResponse = await exchange(started.deviceSecret);
    const issued = cliDeviceAuthorizationExchangeResponseSchema.parse(await issuedResponse.json());
    if (issued.status !== "authorized") throw new Error("Expected authorized exchange");
    const authorization = { Authorization: `Bearer ${issued.credential}` };

    const revoke = await SELF.fetch(`${API}/credentials/current`, {
      method: "DELETE",
      headers: authorization,
    });
    expect(revoke.status).toBe(204);
    expect((await SELF.fetch(`${API}/me`, { headers: authorization })).status).toBe(401);

    const second = await start();
    expect((await approve(second.userCode)).status).toBe(204);
    const secondIssuedResponse = await exchange(second.deviceSecret);
    const secondIssued = cliDeviceAuthorizationExchangeResponseSchema.parse(
      await secondIssuedResponse.json()
    );
    if (secondIssued.status !== "authorized") throw new Error("Expected authorized exchange");
    await env.DB.prepare("UPDATE cli_credentials SET expires_at = 1").run();
    expect(
      (
        await SELF.fetch(`${API}/me`, {
          headers: { Authorization: `Bearer ${secondIssued.credential}` },
        })
      ).status
    ).toBe(401);
  });

  it("capability revocation before issuance prevents later credential creation", async () => {
    const started = await start();

    expect((await revokeIssued(started.deviceSecret)).status).toBe(204);
    expect((await approve(started.userCode)).status).toBe(409);
    expect((await exchange(started.deviceSecret)).status).toBe(410);
    expect(await env.DB.prepare("SELECT 1 FROM cli_credentials").first()).toBeNull();
  });

  it("capability revocation links and revokes an issued credential idempotently", async () => {
    const started = await start();
    expect((await approve(started.userCode)).status).toBe(204);
    const issuedResponse = await exchange(started.deviceSecret);
    const issued = cliDeviceAuthorizationExchangeResponseSchema.parse(await issuedResponse.json());
    if (issued.status !== "authorized") throw new Error("Expected authorized exchange");

    expect((await revokeIssued(started.deviceSecret)).status).toBe(204);
    expect((await revokeIssued(started.deviceSecret)).status).toBe(204);
    expect(
      (
        await SELF.fetch(`${API}/me`, {
          headers: { Authorization: `Bearer ${issued.credential}` },
        })
      ).status
    ).toBe(401);
    await expect(
      env.DB.prepare(
        "SELECT issued_credential_id, capability_revoked_at FROM cli_device_authorization_attempts"
      ).first()
    ).resolves.toMatchObject({
      issued_credential_id: issued.credentialId,
      capability_revoked_at: expect.any(Number),
    });
  });

  it("returns the same capability result for a wrong secret without revoking the known attempt", async () => {
    const started = await start();
    expect((await approve(started.userCode)).status).toBe(204);
    const issuedResponse = await exchange(started.deviceSecret);
    const issued = cliDeviceAuthorizationExchangeResponseSchema.parse(await issuedResponse.json());
    if (issued.status !== "authorized") throw new Error("Expected authorized exchange");

    const [knownShape, unknownShape] = await Promise.all([
      revokeIssued(started.deviceSecret),
      revokeIssued("f".repeat(64)),
    ]);
    expect(knownShape.status).toBe(204);
    expect(unknownShape.status).toBe(204);
    expect(await knownShape.text()).toBe("");
    expect(await unknownShape.text()).toBe("");
    expect(
      (
        await SELF.fetch(`${API}/me`, {
          headers: { Authorization: `Bearer ${issued.credential}` },
        })
      ).status
    ).toBe(401);
  });

  it("returns not found for a well-formed unknown human code", async () => {
    expect((await pending("ZZZZ-ZZZZ")).status).toBe(404);
  });

  it("rate limits start by installation/IP and approval by user", async () => {
    const headers = { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.10" };
    const starts = await Promise.all(
      Array.from({ length: CLI_AUTH_RATE_LIMITS.startPerIp.limit + 1 }, () =>
        SELF.fetch(`${API}/device-authorizations`, {
          method: "POST",
          headers,
          body: JSON.stringify({ deviceName: "rate-limit laptop" }),
        })
      )
    );
    expect(starts.filter((response) => response.status === 201)).toHaveLength(
      CLI_AUTH_RATE_LIMITS.startPerIp.limit
    );
    expect(starts.filter((response) => response.status === 429)).toHaveLength(1);

    for (let index = 0; index < CLI_AUTH_RATE_LIMITS.approvalPerUser.limit; index += 1) {
      const code = index.toString(36).toUpperCase().padStart(4, "A");
      expect((await approve(`AAAA-${code}`)).status).toBe(404);
    }
    const blockedApproval = await approve("BBBB-BBBB");
    expect(blockedApproval.status).toBe(429);
    expect(blockedApproval.headers.get("Retry-After")).toMatch(/^\d+$/);
  });

  it("applies the same secret-keyed exchange limit without revealing attempt existence", async () => {
    const started = await start();
    const unknownSecret = "f".repeat(64);
    const now = Date.now();
    const windowMs = CLI_AUTH_RATE_LIMITS.exchangePerSecret.windowMs;
    const windowStartedAt = Math.floor(now / windowMs) * windowMs;
    for (const secret of [started.deviceSecret, unknownSecret]) {
      await env.DB.prepare(
        `INSERT INTO cli_auth_rate_limits
           (rate_key, window_started_at, request_count, expires_at) VALUES (?, ?, ?, ?)`
      )
        .bind(
          `exchange-secret:${await hashToken(secret)}`,
          windowStartedAt,
          CLI_AUTH_RATE_LIMITS.exchangePerSecret.limit,
          windowStartedAt + windowMs
        )
        .run();
    }
    const [known, unknown] = await Promise.all([
      exchange(started.deviceSecret),
      exchange(unknownSecret),
    ]);
    expect(known.status).toBe(429);
    expect(unknown.status).toBe(429);
    await expect(known.json()).resolves.toEqual({ error: "Too many requests" });
    await expect(unknown.json()).resolves.toEqual({ error: "Too many requests" });
  });

  it("rate limits capability revocation identically for known and unknown secrets", async () => {
    const started = await start();
    const unknownSecret = "f".repeat(64);
    const now = Date.now();
    const windowMs = CLI_AUTH_RATE_LIMITS.capabilityRevokePerSecret.windowMs;
    const windowStartedAt = Math.floor(now / windowMs) * windowMs;
    for (const secret of [started.deviceSecret, unknownSecret]) {
      await env.DB.prepare(
        `INSERT INTO cli_auth_rate_limits
           (rate_key, window_started_at, request_count, expires_at) VALUES (?, ?, ?, ?)`
      )
        .bind(
          `capability-revoke-secret:${await hashToken(secret)}`,
          windowStartedAt,
          CLI_AUTH_RATE_LIMITS.capabilityRevokePerSecret.limit,
          windowStartedAt + windowMs
        )
        .run();
    }

    const [known, unknown] = await Promise.all([
      revokeIssued(started.deviceSecret),
      revokeIssued(unknownSecret),
    ]);
    expect(known.status).toBe(429);
    expect(unknown.status).toBe(429);
    await expect(known.json()).resolves.toEqual({ error: "Too many requests" });
    await expect(unknown.json()).resolves.toEqual({ error: "Too many requests" });
  });

  it("allows correctly paced one-second polling beyond sixty attempts", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const started = await start();

    for (let poll = 0; poll < 61; poll += 1) {
      now += 1_001;
      expect((await exchange(started.deviceSecret)).status).toBe(202);
    }
  }, 15_000);

  it("opportunistically prunes retained attempts, credentials, and stale counters", async () => {
    await pending("ZZZZ-ZZZZ");
    const now = Date.now();
    const userId = "11111111111111111111111111111111";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO cli_device_authorization_attempts
          (id, device_name, device_secret_hash, user_code_hash, created_at, expires_at)
         VALUES ('old-attempt', 'old', 'old-secret-hash', 'old-code-hash', 1, ?),
                ('recent-attempt', 'recent', 'recent-secret-hash', 'recent-code-hash', 1, ?)`
      ).bind(now - CLI_DEVICE_ATTEMPT_RETENTION_MS - 1, now - 1),
      env.DB.prepare(
        `INSERT INTO cli_credentials
          (id, token_hash, user_id, created_at, expires_at, revoked_at)
         VALUES ('old-expired', 'old-expired-hash', ?, 1, ?, NULL),
                ('old-revoked', 'old-revoked-hash', ?, 1, ?, ?),
                ('active', 'active-hash', ?, 1, ?, NULL)`
      ).bind(
        userId,
        now - CLI_CREDENTIAL_RETENTION_MS - 1,
        userId,
        now + CLI_CREDENTIAL_RETENTION_MS,
        now - CLI_CREDENTIAL_RETENTION_MS - 1,
        userId,
        now + CLI_CREDENTIAL_RETENTION_MS
      ),
      env.DB.prepare(
        `INSERT INTO cli_auth_rate_limits
          (rate_key, window_started_at, request_count, expires_at)
         VALUES ('stale', 1, 1, 1)`
      ),
    ]);

    await start();

    const attempts = await env.DB.prepare(
      "SELECT id FROM cli_device_authorization_attempts ORDER BY id"
    ).all<{ id: string }>();
    expect(attempts.results.map((row) => row.id)).toContain("recent-attempt");
    expect(attempts.results.map((row) => row.id)).not.toContain("old-attempt");
    const credentials = await env.DB.prepare("SELECT id FROM cli_credentials ORDER BY id").all<{
      id: string;
    }>();
    expect(credentials.results.map((row) => row.id)).toEqual(["active"]);
    expect(
      await env.DB.prepare("SELECT 1 FROM cli_auth_rate_limits WHERE rate_key = 'stale'").first()
    ).toBeNull();
  });

  it("does not accept a user code as a polling credential", async () => {
    const started = await start();
    const response = await exchange(started.userCode);
    expect(response.status).toBe(400);
  });
});
