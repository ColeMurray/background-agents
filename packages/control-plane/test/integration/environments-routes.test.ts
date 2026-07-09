/**
 * Environment routes over SELF.fetch: internal-HMAC auth, create-time validation
 * (which short-circuits before SCM resolution), GET/DELETE, the environment
 * secrets routes, and the member-scoped, value-free secret import.
 *
 * The happy-path create (POST /environments) resolves repositories through the SCM
 * provider, which is unconfigured in the test env — so environments needing to
 * exist are seeded directly via EnvironmentStore (mirroring PR-4's split).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import { generateInternalToken } from "../../src/auth/internal";
import { EnvironmentStore } from "../../src/db/environments";
import { RepoSecretsStore } from "../../src/db/repo-secrets";
import { cleanD1Tables } from "./cleanup";

const BASE = "https://test.local";

async function authHeaders(): Promise<Record<string, string>> {
  const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function seedEnvironment(opts?: {
  id?: string;
  name?: string;
  repositories?: [string, string, number, string][];
}): Promise<string> {
  const store = new EnvironmentStore(env.DB);
  const id = opts?.id ?? `env_${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  await store.create(
    {
      id,
      name: opts?.name ?? "Seeded",
      description: null,
      prebuild_enabled: 0,
      created_at: now,
      updated_at: now,
    },
    (opts?.repositories ?? [["acme", "web", 1, "main"]]).map(([o, n, rid, b], position) => ({
      position,
      repo_owner: o,
      repo_name: n,
      repo_id: rid,
      base_branch: b,
    }))
  );
  return id;
}

describe("Environments API (routes)", () => {
  beforeEach(cleanD1Tables);

  describe("auth", () => {
    it("returns 401 without internal auth", async () => {
      const cases = [
        ["GET", "/environments"],
        ["POST", "/environments"],
        ["GET", "/environments/env_x"],
        ["DELETE", "/environments/env_x"],
        ["GET", "/environments/env_x/secrets"],
        ["POST", "/environments/env_x/secrets/import"],
      ] as const;
      for (const [method, path] of cases) {
        const res = await SELF.fetch(`${BASE}${path}`, {
          method,
          headers: { "Content-Type": "application/json" },
          body: method === "GET" || method === "DELETE" ? undefined : "{}",
        });
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    });
  });

  describe("POST /environments (validation before SCM resolution)", () => {
    it("rejects a missing name (400)", async () => {
      const res = await SELF.fetch(`${BASE}/environments`, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ repositories: [{ repoOwner: "acme", repoName: "web" }] }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects empty repositories (400)", async () => {
      const res = await SELF.fetch(`${BASE}/environments`, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ name: "X", repositories: [] }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects a duplicate name before resolving repos (409)", async () => {
      await seedEnvironment({ name: "Taken" });
      const res = await SELF.fetch(`${BASE}/environments`, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({
          name: "taken",
          repositories: [{ repoOwner: "acme", repoName: "api" }],
        }),
      });
      expect(res.status).toBe(409);
    });
  });

  describe("GET/DELETE /environments/:id", () => {
    it("lists and fetches seeded environments", async () => {
      const id = await seedEnvironment({
        name: "Listed",
        repositories: [
          ["acme", "web", 1, "main"],
          ["acme", "api", 2, "develop"],
        ],
      });
      const headers = await authHeaders();

      const listRes = await SELF.fetch(`${BASE}/environments`, { headers });
      expect(listRes.status).toBe(200);
      const list = await listRes.json<{
        environments: { id: string; repositories: unknown[] }[];
        total: number;
      }>();
      expect(list.total).toBe(1);
      expect(list.environments[0].repositories.length).toBe(2);

      const getRes = await SELF.fetch(`${BASE}/environments/${id}`, { headers });
      expect(getRes.status).toBe(200);
      const got = await getRes.json<{
        environment: { name: string; repositories: { repoName: string }[] };
      }>();
      expect(got.environment.name).toBe("Listed");
      expect(got.environment.repositories.map((m) => m.repoName)).toEqual(["web", "api"]);
    });

    it("returns 404 for an unknown environment", async () => {
      const headers = await authHeaders();
      expect((await SELF.fetch(`${BASE}/environments/env_missing`, { headers })).status).toBe(404);
      expect(
        (await SELF.fetch(`${BASE}/environments/env_missing`, { method: "DELETE", headers })).status
      ).toBe(404);
    });

    it("deletes an environment and cascades its secret rows", async () => {
      const id = await seedEnvironment({ name: "Gone" });
      const headers = await authHeaders();
      await SELF.fetch(`${BASE}/environments/${id}/secrets`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ secrets: { K: "v" } }),
      });

      const delRes = await SELF.fetch(`${BASE}/environments/${id}`, { method: "DELETE", headers });
      expect(delRes.status).toBe(200);
      expect((await SELF.fetch(`${BASE}/environments/${id}`, { headers })).status).toBe(404);
      const secretCount = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM environment_secrets WHERE environment_id = ?"
      )
        .bind(id)
        .first<{ c: number }>();
      expect(secretCount?.c).toBe(0);
    });
  });

  describe("environment secrets routes", () => {
    it("sets, lists (with global), and deletes secrets on a seeded environment", async () => {
      const id = await seedEnvironment();
      const headers = await authHeaders();

      await SELF.fetch(`${BASE}/secrets`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ secrets: { GLOBAL_ONE: "g" } }),
      });

      const putRes = await SELF.fetch(`${BASE}/environments/${id}/secrets`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ secrets: { ENV_ONE: "1", ENV_TWO: "2" } }),
      });
      expect(putRes.status).toBe(200);

      const listRes = await SELF.fetch(`${BASE}/environments/${id}/secrets`, { headers });
      expect(listRes.status).toBe(200);
      const list = await listRes.json<{
        environmentId: string;
        secrets: { key: string }[];
        globalSecrets: { key: string }[];
      }>();
      expect(list.environmentId).toBe(id);
      expect(list.secrets.map((s) => s.key)).toEqual(["ENV_ONE", "ENV_TWO"]);
      expect(list.globalSecrets.map((s) => s.key)).toEqual(["GLOBAL_ONE"]);

      const delRes = await SELF.fetch(`${BASE}/environments/${id}/secrets/ENV_ONE`, {
        method: "DELETE",
        headers,
      });
      expect(delRes.status).toBe(200);
      const after = await SELF.fetch(`${BASE}/environments/${id}/secrets`, { headers });
      expect(
        (await after.json<{ secrets: { key: string }[] }>()).secrets.map((s) => s.key)
      ).toEqual(["ENV_TWO"]);
    });

    it("returns 404 when the environment does not exist", async () => {
      const res = await SELF.fetch(`${BASE}/environments/env_missing/secrets`, {
        method: "PUT",
        headers: await authHeaders(),
        body: JSON.stringify({ secrets: { K: "v" } }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /environments/:id/secrets/import", () => {
    it("imports from a member repo and returns key names only", async () => {
      const id = await seedEnvironment({ repositories: [["acme", "web", 1, "main"]] });
      const headers = await authHeaders();
      await new RepoSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY!).setSecrets(
        1,
        "acme",
        "web",
        {
          DEPLOY_KEY: "supersecretvalue",
        }
      );

      const res = await SELF.fetch(`${BASE}/environments/${id}/secrets/import`, {
        method: "POST",
        headers,
        body: JSON.stringify({ repoOwner: "acme", repoName: "web", keys: ["DEPLOY_KEY"] }),
      });
      expect(res.status).toBe(200);
      const raw = await res.text();
      // Value-free: neither plaintext nor ciphertext leaks into the response.
      expect(raw).not.toContain("supersecretvalue");
      const body = JSON.parse(raw) as { status: string; keys: string[]; created: number };
      expect(body.status).toBe("imported");
      expect(body.keys).toEqual(["DEPLOY_KEY"]);
      expect(body.created).toBe(1);

      const listRes = await SELF.fetch(`${BASE}/environments/${id}/secrets`, { headers });
      expect(
        (await listRes.json<{ secrets: { key: string }[] }>()).secrets.map((s) => s.key)
      ).toEqual(["DEPLOY_KEY"]);
    });

    it("rejects a non-member source with 403 and imports nothing", async () => {
      const id = await seedEnvironment({ repositories: [["acme", "web", 1, "main"]] });
      const headers = await authHeaders();
      await new RepoSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY!).setSecrets(
        2,
        "acme",
        "other",
        {
          SECRET: "leakme",
        }
      );

      const res = await SELF.fetch(`${BASE}/environments/${id}/secrets/import`, {
        method: "POST",
        headers,
        body: JSON.stringify({ repoOwner: "acme", repoName: "other", keys: ["SECRET"] }),
      });
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain("leakme");

      const listRes = await SELF.fetch(`${BASE}/environments/${id}/secrets`, { headers });
      expect((await listRes.json<{ secrets: unknown[] }>()).secrets).toEqual([]);
    });
  });
});
