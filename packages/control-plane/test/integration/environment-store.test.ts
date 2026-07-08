/**
 * EnvironmentStore: D1 CRUD, case-insensitive name uniqueness, member ordering,
 * and the application-level DELETE cascade (member + secret rows, image
 * supersede). Exercises migration 0033 by construction — the queries fail if it
 * did not apply.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  EnvironmentStore,
  toEnvironment,
  type EnvironmentRow,
  type EnvironmentRepositoryInsert,
} from "../../src/db/environments";
import { cleanD1Tables } from "./cleanup";

function makeEnv(overrides?: Partial<EnvironmentRow>): EnvironmentRow {
  const now = Date.now();
  return {
    id: `env_${Math.random().toString(36).slice(2, 10)}`,
    name: "Full Stack",
    description: null,
    prebuild_enabled: 0,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function repos(...specs: [string, string, number, string][]): EnvironmentRepositoryInsert[] {
  return specs.map(([repo_owner, repo_name, repo_id, base_branch], position) => ({
    position,
    repo_owner,
    repo_name,
    repo_id,
    base_branch,
  }));
}

describe("EnvironmentStore", () => {
  beforeEach(cleanD1Tables);

  it("creates an environment with members in position order and reads them back", async () => {
    const store = new EnvironmentStore(env.DB);
    const row = makeEnv({ name: "Full Stack", description: "web + api", prebuild_enabled: 1 });
    await store.create(row, repos(["acme", "web", 1, "main"], ["acme", "api", 2, "develop"]));

    const got = await store.getById(row.id);
    expect(got).not.toBeNull();
    const environment = toEnvironment(got!, await store.getRepositoriesForEnvironment(row.id));
    expect(environment.name).toBe("Full Stack");
    expect(environment.description).toBe("web + api");
    expect(environment.prebuildEnabled).toBe(true);
    expect(environment.repositories).toEqual([
      { repoOwner: "acme", repoName: "web", repoId: 1, baseBranch: "main" },
      { repoOwner: "acme", repoName: "api", repoId: 2, baseBranch: "develop" },
    ]);
  });

  it("resolves names case-insensitively via getByName", async () => {
    const store = new EnvironmentStore(env.DB);
    await store.create(makeEnv({ name: "Payments" }), repos(["acme", "web", 1, "main"]));
    expect(await store.getByName("payments")).not.toBeNull();
    expect(await store.getByName("PAYMENTS")).not.toBeNull();
    expect(await store.getByName("other")).toBeNull();
  });

  it("rejects a case-insensitive duplicate name at the unique index", async () => {
    const store = new EnvironmentStore(env.DB);
    await store.create(makeEnv({ name: "Dup" }), repos(["acme", "web", 1, "main"]));
    await expect(
      store.create(makeEnv({ name: "dup" }), repos(["acme", "api", 2, "main"]))
    ).rejects.toThrow();
  });

  it("lists environments newest-first", async () => {
    const store = new EnvironmentStore(env.DB);
    await store.create(makeEnv({ name: "A", created_at: 1000 }), repos(["acme", "web", 1, "main"]));
    await store.create(makeEnv({ name: "B", created_at: 2000 }), repos(["acme", "api", 2, "main"]));
    const { environments, total } = await store.list();
    expect(total).toBe(2);
    expect(environments.map((e) => e.name)).toEqual(["B", "A"]);
  });

  it("updates scalar fields and replaces the member set atomically", async () => {
    const store = new EnvironmentStore(env.DB);
    const row = makeEnv({ name: "Before", prebuild_enabled: 0 });
    await store.create(row, repos(["acme", "web", 1, "main"]));

    const updated = await store.update(
      row.id,
      { name: "After", prebuild_enabled: 1 },
      repos(["acme", "api", 2, "develop"], ["acme", "worker", 3, "main"])
    );
    expect(updated?.name).toBe("After");
    expect(updated?.prebuild_enabled).toBe(1);
    const repoRows = await store.getRepositoriesForEnvironment(row.id);
    expect(repoRows.map((r) => r.repo_name)).toEqual(["api", "worker"]);
  });

  it("bumps updated_at on a members-only edit", async () => {
    const store = new EnvironmentStore(env.DB);
    const row = makeEnv({ name: "Bump", created_at: 1000, updated_at: 1000 });
    await store.create(row, repos(["acme", "web", 1, "main"]));
    const updated = await store.update(row.id, {}, repos(["acme", "api", 2, "main"]));
    expect(updated!.updated_at).toBeGreaterThan(1000);
  });

  it("cascade-deletes members + secrets and supersedes only live images", async () => {
    const store = new EnvironmentStore(env.DB);
    const row = makeEnv({ name: "Doomed" });
    await store.create(row, repos(["acme", "web", 1, "main"], ["acme", "api", 2, "main"]));

    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO environment_secrets (environment_id, key, encrypted_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(row.id, "TOKEN", "cipher", now, now)
      .run();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO environment_images (id, environment_id, members_fingerprint, member_shas, runtime_version, status, created_at) VALUES (?, ?, ?, ?, ?, 'ready', ?)"
      ).bind("img_ready", row.id, "fp", "[]", "v3", now),
      env.DB.prepare(
        "INSERT INTO environment_images (id, environment_id, members_fingerprint, member_shas, runtime_version, status, created_at) VALUES (?, ?, ?, ?, ?, 'failed', ?)"
      ).bind("img_failed", row.id, "fp", "[]", "v3", now),
    ]);

    expect(await store.delete(row.id)).toBe(true);

    expect(await store.getById(row.id)).toBeNull();
    expect((await store.getRepositoriesForEnvironment(row.id)).length).toBe(0);
    const secretCount = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM environment_secrets WHERE environment_id = ?"
    )
      .bind(row.id)
      .first<{ c: number }>();
    expect(secretCount?.c).toBe(0);
    const ready = await env.DB.prepare(
      "SELECT status FROM environment_images WHERE id = 'img_ready'"
    ).first<{ status: string }>();
    expect(ready?.status).toBe("superseded");
    const failed = await env.DB.prepare(
      "SELECT status FROM environment_images WHERE id = 'img_failed'"
    ).first<{ status: string }>();
    expect(failed?.status).toBe("failed"); // pre-existing terminal status untouched
  });

  it("delete is idempotent (false the second time)", async () => {
    const store = new EnvironmentStore(env.DB);
    const row = makeEnv({ name: "Once" });
    await store.create(row, repos(["acme", "web", 1, "main"]));
    expect(await store.delete(row.id)).toBe(true);
    expect(await store.delete(row.id)).toBe(false);
  });

  it("cascade-deletes child repository + secret rows via FK on parent delete", async () => {
    const store = new EnvironmentStore(env.DB);
    const row = makeEnv({ name: "FkCascade" });
    await store.create(row, repos(["acme", "web", 1, "main"], ["acme", "api", 2, "main"]));
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO environment_secrets (environment_id, key, encrypted_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(row.id, "TOKEN", "cipher", now, now)
      .run();

    // Raw parent delete (bypassing store.delete's explicit child deletes) so the
    // ON DELETE CASCADE FK is what reclaims the children.
    await env.DB.prepare("DELETE FROM environments WHERE id = ?").bind(row.id).run();

    expect((await store.getRepositoriesForEnvironment(row.id)).length).toBe(0);
    const secretCount = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM environment_secrets WHERE environment_id = ?"
    )
      .bind(row.id)
      .first<{ c: number }>();
    expect(secretCount?.c).toBe(0);
  });
});
