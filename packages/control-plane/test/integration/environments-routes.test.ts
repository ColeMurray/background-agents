/**
 * Environment routes over serviceFetch: service sig1 auth, create-time validation
 * (which short-circuits before SCM resolution), GET/DELETE, the environment
 * secrets routes, and the member-scoped, value-free secret import.
 *
 * The happy-path create (POST /environments) resolves repositories through the SCM
 * provider, which is unconfigured in the test env — so environments needing to
 * exist are seeded directly via EnvironmentStore (mirroring PR-4's split).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import { EnvironmentStore } from "../../src/db/environments";
import { RepoSecretsStore } from "../../src/db/repo-secrets";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

const BASE = "https://test.local";

async function seedEnvironment(opts?: {
  id?: string;
  name?: string;
  channelAssociations?: string[];
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
      channel_associations: opts?.channelAssociations
        ? JSON.stringify(opts.channelAssociations)
        : null,
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
      const res = await serviceFetch(`${BASE}/environments`, {
        method: "POST",
        body: JSON.stringify({ repositories: [{ repoOwner: "acme", repoName: "web" }] }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects empty repositories (400)", async () => {
      const res = await serviceFetch(`${BASE}/environments`, {
        method: "POST",
        body: JSON.stringify({ name: "X", repositories: [] }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects a duplicate name before resolving repos (409)", async () => {
      await seedEnvironment({ name: "Taken" });
      const res = await serviceFetch(`${BASE}/environments`, {
        method: "POST",
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

      const listRes = await serviceFetch(`${BASE}/environments`);
      expect(listRes.status).toBe(200);
      const list = await listRes.json<{
        environments: { id: string; repositories: unknown[] }[];
        total: number;
      }>();
      expect(list.total).toBe(1);
      expect(list.environments[0].repositories.length).toBe(2);

      const getRes = await serviceFetch(`${BASE}/environments/${id}`);
      expect(getRes.status).toBe(200);
      const got = await getRes.json<{
        environment: { name: string; repositories: { repoName: string }[] };
      }>();
      expect(got.environment.name).toBe("Listed");
      expect(got.environment.repositories.map((m) => m.repoName)).toEqual(["web", "api"]);
    });

    it("returns 404 for an unknown environment", async () => {
      expect((await serviceFetch(`${BASE}/environments/env_missing`)).status).toBe(404);
      expect(
        (await serviceFetch(`${BASE}/environments/env_missing`, { method: "DELETE" })).status
      ).toBe(404);
    });

    it("deletes an environment and cascades its secret rows", async () => {
      const id = await seedEnvironment({ name: "Gone" });
      await serviceFetch(`${BASE}/environments/${id}/secrets`, {
        method: "PUT",
        body: JSON.stringify({ secrets: { K: "v" } }),
      });

      const delRes = await serviceFetch(`${BASE}/environments/${id}`, { method: "DELETE" });
      expect(delRes.status).toBe(200);
      expect((await serviceFetch(`${BASE}/environments/${id}`)).status).toBe(404);
      const secretCount = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM environment_secrets WHERE environment_id = ?"
      )
        .bind(id)
        .first<{ c: number }>();
      expect(secretCount?.c).toBe(0);
    });
  });

  describe("PUT /environments/:id (channel associations)", () => {
    it("sets, dedupes, and clears channel associations without touching repositories", async () => {
      const id = await seedEnvironment({ name: "Channelled" });

      const putRes = await serviceFetch(`${BASE}/environments/${id}`, {
        method: "PUT",
        body: JSON.stringify({ channelAssociations: ["C111", "C222", "C111"] }),
      });
      expect(putRes.status).toBe(200);
      const updated = await putRes.json<{
        environment: { channelAssociations?: string[]; repositories: unknown[] };
      }>();
      expect(updated.environment.channelAssociations).toEqual(["C111", "C222"]);
      expect(updated.environment.repositories.length).toBe(1);

      // A patch that omits the field leaves the set untouched.
      await serviceFetch(`${BASE}/environments/${id}`, {
        method: "PUT",
        body: JSON.stringify({ description: "still channelled" }),
      });
      const got = await (
        await serviceFetch(`${BASE}/environments/${id}`)
      ).json<{ environment: { channelAssociations?: string[] } }>();
      expect(got.environment.channelAssociations).toEqual(["C111", "C222"]);

      // An empty array clears the set (the column collapses to NULL).
      const clearRes = await serviceFetch(`${BASE}/environments/${id}`, {
        method: "PUT",
        body: JSON.stringify({ channelAssociations: [] }),
      });
      const cleared = await clearRes.json<{ environment: { channelAssociations?: string[] } }>();
      expect(cleared.environment.channelAssociations).toBeUndefined();
    });

    it("lists seeded channel associations", async () => {
      await seedEnvironment({ name: "Listed", channelAssociations: ["C123"] });
      const list = await (
        await serviceFetch(`${BASE}/environments`)
      ).json<{ environments: { channelAssociations?: string[] }[] }>();
      expect(list.environments[0].channelAssociations).toEqual(["C123"]);
    });

    it("rejects malformed channel associations (400)", async () => {
      const id = await seedEnvironment({ name: "Strict" });
      for (const channelAssociations of ["C123", [""], [42]]) {
        const res = await serviceFetch(`${BASE}/environments/${id}`, {
          method: "PUT",
          body: JSON.stringify({ channelAssociations }),
        });
        expect(res.status, JSON.stringify(channelAssociations)).toBe(400);
      }
    });
  });

  describe("environment secrets routes", () => {
    it("sets, lists (with global), and deletes secrets on a seeded environment", async () => {
      const id = await seedEnvironment();

      await serviceFetch(`${BASE}/secrets`, {
        method: "PUT",
        body: JSON.stringify({ secrets: { GLOBAL_ONE: "g" } }),
      });

      const putRes = await serviceFetch(`${BASE}/environments/${id}/secrets`, {
        method: "PUT",
        body: JSON.stringify({ secrets: { ENV_ONE: "1", ENV_TWO: "2" } }),
      });
      expect(putRes.status).toBe(200);

      const listRes = await serviceFetch(`${BASE}/environments/${id}/secrets`);
      expect(listRes.status).toBe(200);
      const list = await listRes.json<{
        environmentId: string;
        secrets: { key: string }[];
        globalSecrets: { key: string }[];
      }>();
      expect(list.environmentId).toBe(id);
      expect(list.secrets.map((s) => s.key)).toEqual(["ENV_ONE", "ENV_TWO"]);
      expect(list.globalSecrets.map((s) => s.key)).toEqual(["GLOBAL_ONE"]);

      const delRes = await serviceFetch(`${BASE}/environments/${id}/secrets/ENV_ONE`, {
        method: "DELETE",
      });
      expect(delRes.status).toBe(200);
      const after = await serviceFetch(`${BASE}/environments/${id}/secrets`);
      expect(
        (await after.json<{ secrets: { key: string }[] }>()).secrets.map((s) => s.key)
      ).toEqual(["ENV_TWO"]);
    });

    it("returns 404 when the environment does not exist", async () => {
      const res = await serviceFetch(`${BASE}/environments/env_missing/secrets`, {
        method: "PUT",
        body: JSON.stringify({ secrets: { K: "v" } }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /environments/:id/secrets/import", () => {
    it("imports from a member repo and returns key names only", async () => {
      const id = await seedEnvironment({ repositories: [["acme", "web", 1, "main"]] });
      await new RepoSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY!).setSecrets(
        1,
        "acme",
        "web",
        {
          DEPLOY_KEY: "supersecretvalue",
        }
      );

      const res = await serviceFetch(`${BASE}/environments/${id}/secrets/import`, {
        method: "POST",
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

      const listRes = await serviceFetch(`${BASE}/environments/${id}/secrets`);
      expect(
        (await listRes.json<{ secrets: { key: string }[] }>()).secrets.map((s) => s.key)
      ).toEqual(["DEPLOY_KEY"]);
    });

    it("rejects a non-member source with 403 and imports nothing", async () => {
      const id = await seedEnvironment({ repositories: [["acme", "web", 1, "main"]] });
      await new RepoSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY!).setSecrets(
        2,
        "acme",
        "other",
        {
          SECRET: "leakme",
        }
      );

      const res = await serviceFetch(`${BASE}/environments/${id}/secrets/import`, {
        method: "POST",
        body: JSON.stringify({ repoOwner: "acme", repoName: "other", keys: ["SECRET"] }),
      });
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain("leakme");

      const listRes = await serviceFetch(`${BASE}/environments/${id}/secrets`);
      expect((await listRes.json<{ secrets: unknown[] }>()).secrets).toEqual([]);
    });
  });
});
