import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionIndexStore } from "../../src/db/session-index";
import { hashSessionSkillManifest } from "../../src/skills/content-addressing";
import { cleanD1Tables } from "./cleanup";

const migration = () => {
  const entry = env.TEST_MIGRATIONS.find((candidate) => candidate.name.startsWith("0075"));
  if (!entry) throw new Error("Migration 0075 not found in TEST_MIGRATIONS");
  return entry;
};

describe("migration 0075: session skill manifests", () => {
  beforeEach(cleanD1Tables);

  it("backfills existing sessions with the canonical empty manifest", async () => {
    const createdAt = Date.now();
    await new SessionIndexStore(env.DB).create({
      id: "pre-managed-skills",
      title: null,
      repoOwner: null,
      repoName: null,
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: null,
      status: "created",
      createdAt,
      updatedAt: createdAt,
    });

    await env.DB.batch(migration().queries.map((query) => env.DB.prepare(query)));

    await expect(
      env.DB.prepare("SELECT * FROM session_skill_manifests WHERE session_id = ?")
        .bind("pre-managed-skills")
        .first()
    ).resolves.toMatchObject({
      selection_mode: "all",
      profile_id: null,
      profile_name: null,
      resolver_version: 1,
      manifest_sha256: await hashSessionSkillManifest({ mode: "all" }, []),
      resolved_at: createdAt,
    });
  });
});
