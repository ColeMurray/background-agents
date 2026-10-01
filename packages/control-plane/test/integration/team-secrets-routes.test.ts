import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ImageBuildStore } from "../../src/db/image-builds";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { TeamSecretsStore } from "../../src/db/team-secrets";
import { TeamStore } from "../../src/db/teams";
import { MAX_SECRETS_PER_SCOPE, MAX_VALUE_SIZE } from "../../src/db/secrets-validation";
import { cleanD1Tables } from "./cleanup";
import { routeRequest, serviceRequestHeaders, type ServiceRequestInit } from "./helpers";
import { environmentScope, getRow, seedEnvironment, seedImageRow } from "./image-build-helpers";

const BASE = "https://test.local";
const LEAD = "22222222222222222222222222222222";
const MEMBER = "33333333333333333333333333333333";
const OTHER = "44444444444444444444444444444444";
const ADMIN = "55555555555555555555555555555555";
const OWNER = "11111111111111111111111111111111";
const MODES = ["off", "shadow", "on"] as const;
const METHODS = ["GET", "PUT", "DELETE"] as const;

async function request(
  path: string,
  init: ServiceRequestInit = {},
  mode: (typeof MODES)[number] = "on",
  overrides: Partial<typeof env> = {}
) {
  const url = `${BASE}${path}`;
  return routeRequest(
    new Request(url, {
      method: init.method ?? "GET",
      headers: await serviceRequestHeaders(url, init),
      body: init.body,
    }),
    { ...env, TEAMS_ENFORCEMENT: mode, ...overrides },
    createExecutionContext()
  );
}

function mutationInit(method: (typeof METHODS)[number]): ServiceRequestInit {
  return {
    method,
    ...(method === "PUT" ? { body: JSON.stringify({ secrets: { TOKEN: "new-value" } }) } : {}),
  };
}

describe("team secrets routes", () => {
  let teamId: string;
  let store: TeamSecretsStore;

  beforeEach(async () => {
    await cleanD1Tables();
    for (const [userId, role] of [
      [OWNER, "owner"],
      [LEAD, "member"],
      [MEMBER, "member"],
      [OTHER, "member"],
      [ADMIN, "administrator"],
    ] as const) {
      await serviceRequestHeaders(`${BASE}/me/authorization`, { as: { userId, role } });
    }
    teamId = (
      await new TeamStore(env.DB).create({
        slug: "secrets",
        name: "Secrets",
        joinPolicy: "invite_only",
      })
    ).id;
    const memberships = new TeamMembershipStore(env.DB);
    await memberships.add(teamId, LEAD, "lead");
    await memberships.add(teamId, MEMBER, "member");
    store = new TeamSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY!);
    await store.setSecrets(teamId, { TOKEN: "original-sensitive-value" });
  });

  function path(method: (typeof METHODS)[number], id = teamId) {
    return `/teams/${id}/secrets${method === "DELETE" ? "/token" : ""}`;
  }

  it.each(MODES)(
    "allows leads, administrators and owners to manage secrets in %s mode",
    async (mode) => {
      for (const [userId, role] of [
        [LEAD, "member"],
        [ADMIN, "administrator"],
        [OWNER, "owner"],
      ] as const) {
        await store.setSecrets(teamId, { TOKEN: "original-sensitive-value" });
        for (const method of METHODS) {
          const response = await request(
            path(method),
            { ...mutationInit(method), as: { userId, role } },
            mode
          );
          expect(response.status, `${role}/${method}`).toBe(200);
          expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        }
      }
    }
  );

  it.each(MODES)(
    "denies members, nonmembers, bots and suspended leads in %s mode",
    async (mode) => {
      for (const userId of [MEMBER, OTHER]) {
        for (const method of METHODS) {
          const response = await request(
            path(method),
            { ...mutationInit(method), as: { userId, role: "member" } },
            mode
          );
          expect(response.status, `${userId}/${method}`).toBe(403);
          expect(await response.json()).toMatchObject({ reason_code: "team_capability_required" });
        }
      }
      for (const [service, validActor] of [
        ["slack-bot", "slack:U-SECRET-ACTOR"],
        ["github-bot", "github:987654321"],
        ["linear-bot", "linear:U-SECRET-ACTOR"],
      ] as const) {
        for (const actor of [undefined, validActor]) {
          for (const method of METHODS) {
            const response = await request(
              path(method),
              { ...mutationInit(method), service, actor },
              mode
            );
            expect(response.status, `${service}/${actor}/${method}`).toBe(403);
          }
        }
      }
      await env.DB.prepare("UPDATE users SET suspended_at = ? WHERE id = ?")
        .bind(Date.now(), LEAD)
        .run();
      for (const method of METHODS) {
        expect(
          (
            await request(
              path(method),
              { ...mutationInit(method), as: { userId: LEAD, role: "member" } },
              mode
            )
          ).status
        ).toBe(403);
      }
      expect(await store.getDecryptedSecrets(teamId)).toEqual({
        TOKEN: "original-sensitive-value",
      });
      expect(
        (
          await env.DB.prepare(
            "SELECT action FROM authorization_audit_events WHERE action IN ('team.secret_set', 'team.secret_deleted')"
          ).all()
        ).results
      ).toEqual([]);
    }
  );

  it("returns editor-compatible metadata and mutation responses without plaintext or ciphertext", async () => {
    const other = await new TeamStore(env.DB).create({
      slug: "other",
      name: "Other",
      joinPolicy: "invite_only",
    });
    await store.setSecrets(other.id, { OTHER_TOKEN: "other-team-value" });
    const listed = await request(path("GET"));
    expect(await listed.json()).toEqual({
      teamId,
      secrets: [{ key: "TOKEN", createdAt: expect.any(Number), updatedAt: expect.any(Number) }],
    });
    const saved = await request(path("PUT"), {
      method: "PUT",
      body: JSON.stringify({
        secrets: { token: "replacement-sensitive-value", NEW_KEY: "new-sensitive-value" },
      }),
    });
    expect(await saved.json()).toEqual({
      status: "updated",
      teamId,
      keys: ["TOKEN", "NEW_KEY"],
      created: 1,
      updated: 1,
    });
    const ciphertext = await env.DB.prepare(
      "SELECT encrypted_value FROM team_secrets WHERE team_id = ? AND key = 'TOKEN'"
    )
      .bind(teamId)
      .first<{ encrypted_value: string }>();
    const deleted = await request(path("DELETE"), { method: "DELETE" });
    expect(await deleted.json()).toEqual({ status: "deleted", teamId, key: "TOKEN" });
    const missing = await request(path("DELETE"), { method: "DELETE" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Secret not found" });
    const audits = (await env.DB.prepare("SELECT * FROM authorization_audit_events").all()).results;
    const serialized = JSON.stringify({
      audits,
      metadata: await (await request(path("GET"))).json(),
    });
    for (const value of [
      "original-sensitive-value",
      "replacement-sensitive-value",
      "new-sensitive-value",
      "other-team-value",
      ciphertext!.encrypted_value,
    ]) {
      expect(serialized).not.toContain(value);
    }
    expect(audits.filter((row) => row.action === "team.secret_set")).toHaveLength(1);
    expect(audits.filter((row) => row.action === "team.secret_deleted")).toHaveLength(1);
  });

  it("lists metadata without decrypting stored values", async () => {
    await env.DB.prepare(
      "UPDATE team_secrets SET encrypted_value = 'corrupt-ciphertext' WHERE team_id = ?"
    )
      .bind(teamId)
      .run();
    const response = await request(path("GET"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      teamId,
      secrets: [{ key: "TOKEN", createdAt: expect.any(Number), updatedAt: expect.any(Number) }],
    });
  });

  it.each(["PUT", "DELETE"] as const)(
    "%s makes an owned environment's ready image unselectable and supersedes its in-flight build",
    async (method) => {
      const environmentId = await seedEnvironment({ prebuildEnabled: true });
      await env.DB.prepare("UPDATE environments SET owner_team_id = ? WHERE id = ?")
        .bind(teamId, environmentId)
        .run();
      await seedImageRow({
        id: "team-ready-image",
        environmentId,
        status: "ready",
        providerImageId: "team-secret-artifact",
      });
      await seedImageRow({ id: "team-building-image", environmentId, status: "building" });
      const images = new ImageBuildStore(env.DB);
      const scope = environmentScope(environmentId);
      expect(await images.getLatestReadyForSpawn(scope, "modal")).toMatchObject({
        id: "team-ready-image",
      });

      const response = await request(path(method), mutationInit(method), "on", {
        SANDBOX_PROVIDER: "daytona",
        DAYTONA_PREBUILDS_ENABLED: "false",
      });

      expect(response.status).toBe(200);
      expect(await images.getLatestReadyForSpawn(scope, "modal")).toBeNull();
      expect((await getRow("team-ready-image"))?.status).toBe("superseded");
      expect((await getRow("team-building-image"))?.status).toBe("superseded");
      const audits = (
        await env.DB.prepare(
          "SELECT action, operation_result, metadata_json FROM authorization_audit_events WHERE action IN ('team.secret_set', 'team.secret_deleted')"
        ).all()
      ).results;
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: method === "PUT" ? "team.secret_set" : "team.secret_deleted",
        operation_result: "applied",
      });
      expect(JSON.parse(String(audits[0].metadata_json))).toEqual({
        before: { keys: ["TOKEN"] },
        requested: {},
        after: { keys: method === "PUT" ? ["TOKEN"] : [] },
      });
    }
  );

  it("returns a generic storage error when database row validation fails", async () => {
    await env.DB.prepare(
      "UPDATE team_secrets SET updated_at = 'sensitive-invalid-row' WHERE team_id = ?"
    )
      .bind(teamId)
      .run();
    const response = await request(path("GET"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Secrets storage unavailable" });
  });

  it.each(["{}", "[]", "null", '{"secrets":[]}', '{"secrets":{"TOKEN":42}}', "not-json"])(
    "rejects malformed body %s",
    async (body) => {
      expect((await request(path("PUT"), { method: "PUT", body })).status).toBe(400);
      expect(await store.getDecryptedSecrets(teamId)).toEqual({
        TOKEN: "original-sensitive-value",
      });
    }
  );

  it.each([
    { "BAD-KEY": "value" },
    { PATH: "value" },
    { token: "one", TOKEN: "two" },
    { TOKEN: "x".repeat(MAX_VALUE_SIZE + 1) },
  ])("rejects invalid secrets without leaking values (%#)", async (secrets) => {
    const response = await request(path("PUT"), {
      method: "PUT",
      body: JSON.stringify({ secrets }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("original-sensitive-value");
    expect(await store.getDecryptedSecrets(teamId)).toEqual({ TOKEN: "original-sensitive-value" });
  });

  it("returns validation errors for the key cap and invalid delete keys", async () => {
    await store.setSecrets(
      teamId,
      Object.fromEntries(
        Array.from({ length: MAX_SECRETS_PER_SCOPE - 1 }, (_, i) => [`KEY_${i}`, "value"])
      )
    );
    expect(
      (await request(path("PUT"), { method: "PUT", body: '{"secrets":{"EXTRA":"value"}}' })).status
    ).toBe(400);
    expect((await request(`/teams/${teamId}/secrets/BAD-KEY`, { method: "DELETE" })).status).toBe(
      400
    );
    expect((await request(`/teams/${teamId}/secrets/PATH`, { method: "DELETE" })).status).toBe(400);
    expect(await store.listSecretKeys(teamId)).toHaveLength(MAX_SECRETS_PER_SCOPE);
  });

  it("requires a real team and configured encryption key for every method", async () => {
    for (const method of METHODS) {
      expect((await request(path(method, "team_missing"), mutationInit(method))).status).toBe(404);
      const response = await request(path(method), mutationInit(method), "on", {
        REPO_SECRETS_ENCRYPTION_KEY: undefined,
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "REPO_SECRETS_ENCRYPTION_KEY not configured",
      });
    }
  });

  it("supports non-GitHub SCM configurations", async () => {
    for (const SCM_PROVIDER of ["gitlab", "bitbucket"]) {
      expect((await request(path("GET"), {}, "on", { SCM_PROVIDER })).status).toBe(200);
    }
  });
});
