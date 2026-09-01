import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashToken } from "../../src/auth/crypto";
import { cleanD1Tables } from "./cleanup";
import { seedActiveUser } from "./helpers";

const API = "https://cp.test/external/v1";
const USER_ID = "44444444444444444444444444444444";

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
    .bind(
      "discovery-credential",
      await hashToken(credential),
      USER_ID,
      Date.now(),
      Date.now() + 60_000
    )
    .run();
  return {
    Authorization: `Bearer ${credential}`,
    "X-Open-Inspect-API-Version": "1",
    "X-Open-Inspect-Client-Version": "0.1.0-test",
    "X-Open-Inspect-Client-Surface": "cli",
  };
}

async function seedSkills(names: string[]): Promise<void> {
  await env.DB.batch(
    names.map((name, index) =>
      env.DB.prepare(
        `INSERT INTO skills
         (id, name, enabled, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, 1, 1)`
      ).bind(`skill-${index}`, name, USER_ID, USER_ID)
    )
  );
  await env.DB.batch(
    names.map((_, index) =>
      env.DB.prepare(
        `INSERT INTO skill_revisions
         (id, skill_id, revision_number, revision_sha256, description, body,
          metadata_json, total_bytes, created_by, created_at)
         VALUES (?, ?, 1, ?, 'Description', 'Body', '{}', 4, ?, 1)`
      ).bind(`revision-${index}`, `skill-${index}`, String(index).padStart(64, "0"), USER_ID)
    )
  );
  await env.DB.batch(
    names.map((_, index) =>
      env.DB.prepare("UPDATE skills SET current_revision_id = ? WHERE id = ?").bind(
        `revision-${index}`,
        `skill-${index}`
      )
    )
  );
}

async function seedProfiles(names: string[]): Promise<void> {
  await env.DB.batch(
    names.map((name, index) =>
      env.DB.prepare(
        `INSERT INTO skill_profiles (id, user_id, name, created_at, updated_at)
         VALUES (?, ?, ?, 1, 1)`
      ).bind(`profile-${index}`, USER_ID, name)
    )
  );
}

describe("external V1 discovery API", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  it("paginates environments and returns ordered repository members", async () => {
    const headers = await externalHeaders();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO environments
         (id, name, description, prebuild_enabled, channel_associations, created_at, updated_at)
         VALUES ('env_old', 'Old', NULL, 0, NULL, ?, ?)`
      ).bind(now - 1, now - 1),
      env.DB.prepare(
        `INSERT INTO environments
         (id, name, description, prebuild_enabled, channel_associations, created_at, updated_at)
         VALUES ('env_new', 'New', 'Newest', 1, NULL, ?, ?)`
      ).bind(now, now),
      env.DB.prepare(
        `INSERT INTO environment_repositories
         (environment_id, position, repo_owner, repo_name, repo_id, base_branch)
         VALUES ('env_new', 1, 'acme', 'second', 2, 'main')`
      ),
      env.DB.prepare(
        `INSERT INTO environment_repositories
         (environment_id, position, repo_owner, repo_name, repo_id, base_branch)
         VALUES ('env_new', 0, 'acme', 'first', 1, 'develop')`
      ),
    ]);

    const first = await SELF.fetch(`${API}/environments?limit=1`, { headers });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      environments: [
        {
          id: "env_new",
          repositories: [{ repoName: "first" }, { repoName: "second" }],
        },
      ],
      hasMore: true,
      continuationOffset: 1,
    });

    const second = await SELF.fetch(`${API}/environments?limit=1&offset=1`, { headers });
    await expect(second.json()).resolves.toMatchObject({
      environments: [{ id: "env_old" }],
      hasMore: false,
    });
    const detail = await SELF.fetch(`${API}/environments/env_new`, { headers });
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({ environment: { id: "env_new" } });
  });

  it("returns only enabled model metadata and reasoning options to an active user", async () => {
    const headers = await externalHeaders("role_builtin_viewer");
    await env.DB.prepare(
      "INSERT INTO model_preferences (id, enabled_models, updated_at) VALUES ('global', ?, ?)"
    )
      .bind(JSON.stringify(["openai/gpt-5.6-sol"]), Date.now())
      .run();

    const response = await SELF.fetch(`${API}/models`, { headers });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      models: [
        {
          id: "openai/gpt-5.6-sol",
          name: "GPT 5.6 Sol",
          description: "Frontier model for complex professional work",
          category: "OpenAI",
          reasoning: {
            efforts: ["none", "low", "medium", "high", "xhigh"],
            default: "medium",
          },
        },
      ],
    });
  });

  it("preserves skill discovery while omitting profiles without profile permission", async () => {
    const roleId = "role_skill_reader";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO roles (id, key, name, normalized_name, description, is_system)
         VALUES (?, NULL, 'Skill reader', 'skill reader', NULL, 0)`
      ).bind(roleId),
      env.DB.prepare(
        "INSERT INTO role_permissions (role_id, permission_id) VALUES (?, 'skills.read')"
      ).bind(roleId),
    ]);
    const headers = await externalHeaders(roleId);
    await seedProfiles(["Owned profile"]);
    const response = await SELF.fetch(`${API}/skills`, { headers });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      skills: [],
      profiles: [],
      hasMore: false,
    });
  });

  it("paginates skills and owned profiles as one bounded collection", async () => {
    const headers = await externalHeaders();
    await seedSkills(["Alpha", "Bravo", "Charlie"]);
    await seedProfiles(["First profile", "Second profile"]);

    const first = await SELF.fetch(`${API}/skills?limit=2`, { headers });
    await expect(first.json()).resolves.toMatchObject({
      skills: [{ name: "Alpha" }, { name: "Bravo" }],
      profiles: [],
      hasMore: true,
      continuationOffset: 2,
    });

    const second = await SELF.fetch(`${API}/skills?limit=2&offset=2`, { headers });
    await expect(second.json()).resolves.toMatchObject({
      skills: [{ name: "Charlie" }],
      profiles: [{ name: "First profile" }],
      hasMore: true,
      continuationOffset: 4,
    });

    const third = await SELF.fetch(`${API}/skills?limit=2&offset=4`, { headers });
    await expect(third.json()).resolves.toMatchObject({
      skills: [],
      profiles: [{ name: "Second profile" }],
      hasMore: false,
    });
  });

  it("uses the default list limit across the combined skill collection", async () => {
    const headers = await externalHeaders();
    await seedProfiles(
      Array.from({ length: 51 }, (_, index) => `Profile ${String(index).padStart(2, "0")}`)
    );

    const response = await SELF.fetch(`${API}/skills`, { headers });
    const body = await response.json<{
      skills: unknown[];
      profiles: unknown[];
      hasMore: boolean;
      continuationOffset: number;
    }>();
    expect(body).toMatchObject({
      skills: [],
      hasMore: true,
      continuationOffset: 50,
    });
    expect(body.profiles).toHaveLength(50);
  });

  it("projects provider accounts without identity, audit, or credential fields", async () => {
    const headers = await externalHeaders();
    const accountId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO model_provider_accounts
         (id, provider, display_name, external_account_id, status, created_by, updated_by,
          last_verified_at, created_at, updated_at)
         VALUES (?, 'openai', 'Team account', 'external-secret-looking-id', 'active', ?, ?, ?, ?, ?)`
      ).bind(accountId, USER_ID, USER_ID, now, now, now),
      env.DB.prepare(
        `INSERT INTO model_provider_account_defaults
         (provider, provider_account_id, unattended_mode, created_by, updated_by, created_at, updated_at)
         VALUES ('openai', ?, 'provider_account', ?, ?, ?, ?)`
      ).bind(accountId, USER_ID, USER_ID, now, now),
    ]);

    const response = await SELF.fetch(`${API}/provider-accounts`, { headers });
    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(JSON.stringify(body)).not.toContain("external-secret-looking-id");
    expect(body).toEqual({
      accounts: [
        {
          id: accountId,
          provider: "openai",
          displayName: "Team account",
          status: "active",
          isDefault: true,
          unattendedMode: "provider_account",
        },
      ],
      hasMore: false,
    });
  });

  it("rejects invalid list bounds before querying resources", async () => {
    const headers = await externalHeaders();
    for (const query of [
      "limit=0",
      "limit=101",
      "limit=1.5",
      "limit=",
      "offset=-1",
      "offset=1e2",
      "offset=9007199254740991",
      "offset=9007199254740992",
      "limit=1&limit=2",
      "offset=0&offset=1",
      "unknown=1",
    ]) {
      const response = await SELF.fetch(`${API}/environments?${query}`, { headers });
      expect(response.status, query).toBe(400);
    }
  });

  it("rejects query parameters on discovery endpoints without list parameters", async () => {
    const headers = await externalHeaders();
    const modelResponse = await SELF.fetch(`${API}/models?unknown=1`, { headers });
    expect(modelResponse.status).toBe(400);

    const environmentResponse = await SELF.fetch(`${API}/environments/missing?limit=1`, {
      headers,
    });
    expect(environmentResponse.status).toBe(400);
  });
});
