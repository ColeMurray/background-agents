import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { SKILL_LIST_PAGE_SIZE, type SkillImportSource } from "@open-inspect/shared/types/skills";
import { SkillConflictError, SkillStore } from "../../src/db/skills";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";
import { insertCanonicalUser, insertIdentity } from "./identity-seed-helpers";

const content = {
  description: "Imported deployment instructions",
  body: "# Deployment\n",
  license: null,
  compatibility: null,
  metadata: {},
  files: [{ path: "scripts/deploy.sh", content: "#!/bin/sh\n", executable: true }],
};

const source: SkillImportSource = {
  provider: "github",
  repoOwner: "acme",
  repoName: "skills",
  requestedRef: null,
  resolvedRef: "main",
  commitSha: "a".repeat(40),
  subdirectory: "skills/deploy-service",
  sourceSha256: "b".repeat(64),
};

function importedSkill(skills: SkillStore, name = "acme-deploy") {
  return skills.create({ name, content, assignments: [{ type: "global" }] }, "user_1", source);
}

describe("managed skill import provenance", () => {
  beforeEach(cleanD1Tables);

  it("records the source of an imported skill and reports it on the catalog", async () => {
    const skills = new SkillStore(env.DB);
    const skill = await importedSkill(skills);

    expect(skill.source).toMatchObject({
      ...source,
      revisionId: skill.currentRevisionId,
    });
    expect(skill.source?.importedAt).toBeGreaterThan(0);
    const listed = await skills.list({ limit: SKILL_LIST_PAGE_SIZE, cursor: null });
    expect(listed.skills[0].source?.commitSha).toBe(source.commitSha);
  });

  it("leaves editor-authored skills without a source", async () => {
    const skills = new SkillStore(env.DB);
    const skill = await skills.create({ name: "hand-written", content, assignments: [] }, "user_1");

    expect(skill.source).toBeNull();
    expect(await skills.latestImportSource(skill.id)).toBeNull();
  });

  it("adds a revision and new provenance when re-imported content differs", async () => {
    const skills = new SkillStore(env.DB);
    const skill = await importedSkill(skills);
    const next: SkillImportSource = {
      ...source,
      commitSha: "c".repeat(40),
      sourceSha256: "d".repeat(64),
    };

    const applied = await skills.applyImportedRevision(
      skill.id,
      { ...content, body: "# Deployment v2\n" },
      next,
      "user_2",
      skill.currentRevisionId
    );

    expect(applied?.revisionCreated).toBe(true);
    expect(applied?.skill.revisionNumber).toBe(2);
    expect(applied?.skill.body).toBe("# Deployment v2\n");
    expect(applied?.skill.source).toMatchObject({
      commitSha: next.commitSha,
      revisionId: applied?.skill.currentRevisionId,
    });
    // Assignments belong to the catalog entry, not the imported content.
    expect(applied?.skill.assignments).toHaveLength(1);
  });

  it("selects the most recently inserted source when import timestamps tie", async () => {
    const skills = new SkillStore(env.DB);
    const skill = await importedSkill(skills);
    const next = await skills.applyImportedRevision(
      skill.id,
      { ...content, body: "# Deployment v2\n" },
      { ...source, commitSha: "c".repeat(40), sourceSha256: "d".repeat(64) },
      "user_2",
      skill.currentRevisionId
    );
    await env.DB.prepare("UPDATE skill_import_sources SET imported_at = 1 WHERE skill_id = ?")
      .bind(skill.id)
      .run();

    expect((await skills.latestImportSource(skill.id))?.revisionId).toBe(
      next?.skill.currentRevisionId
    );
  });

  it("uses indexed point lookups for each skill's latest source", async () => {
    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN
       SELECT source.*
       FROM skills skill
       JOIN skill_import_sources source ON source.rowid = (
         SELECT latest.rowid
         FROM skill_import_sources latest
         WHERE latest.skill_id = skill.id
         ORDER BY latest.imported_at DESC, latest.rowid DESC
         LIMIT 1
       )
       WHERE skill.id IN (?)`
    )
      .bind("skill_1")
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail);

    expect(details.some((detail) => detail.includes("idx_skill_import_sources_skill"))).toBe(true);
    expect(details.some((detail) => detail.includes("INTEGER PRIMARY KEY"))).toBe(true);
    expect(
      details.some(
        (detail) =>
          detail.startsWith("SCAN skill_import_sources") || detail.startsWith("SCAN latest")
      )
    ).toBe(false);
  });

  it("is a no-op when the re-imported content is unchanged", async () => {
    const skills = new SkillStore(env.DB);
    const skill = await importedSkill(skills);

    const applied = await skills.applyImportedRevision(
      skill.id,
      content,
      { ...source, commitSha: "c".repeat(40) },
      "user_2",
      skill.currentRevisionId
    );

    expect(applied?.revisionCreated).toBe(false);
    expect(applied?.skill.currentRevisionId).toBe(skill.currentRevisionId);
    expect(applied?.skill.source?.commitSha).toBe(source.commitSha);
  });

  it("rejects a re-import that does not hold the current revision", async () => {
    const skills = new SkillStore(env.DB);
    const skill = await importedSkill(skills);

    await expect(
      skills.applyImportedRevision(skill.id, content, source, "user_2", "skillrev_stale")
    ).rejects.toThrow(SkillConflictError);
  });

  it("rejects a stale no-op after another import stored the same content", async () => {
    const skills = new SkillStore(env.DB);
    const skill = await importedSkill(skills);
    const nextContent = { ...content, body: "# Deployment v2\n" };
    await skills.applyImportedRevision(
      skill.id,
      nextContent,
      { ...source, commitSha: "c".repeat(40), sourceSha256: "d".repeat(64) },
      "user_2",
      skill.currentRevisionId
    );

    await expect(
      skills.applyImportedRevision(skill.id, nextContent, source, "user_3", skill.currentRevisionId)
    ).rejects.toThrow(SkillConflictError);
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM skill_revisions WHERE skill_id = ?")
        .bind(skill.id)
        .first<{ count: number }>()
    ).resolves.toEqual({ count: 2 });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM skill_import_sources WHERE skill_id = ?")
        .bind(skill.id)
        .first<{ count: number }>()
    ).resolves.toEqual({ count: 2 });
  });

  it("keeps reporting the source after the skill is edited by hand", async () => {
    const skills = new SkillStore(env.DB);
    const skill = await importedSkill(skills);

    const edited = await skills.replaceContentAndAssignments(
      skill.id,
      { content: { ...content, body: "# Edited\n" }, assignments: [{ type: "global" }] },
      "user_2",
      skill.currentRevisionId
    );

    expect(edited?.revisionNumber).toBe(2);
    expect(edited?.source).toMatchObject({
      commitSha: source.commitSha,
      revisionId: skill.currentRevisionId,
    });
  });

  it("keeps an imported name reserved after deletion", async () => {
    const skills = new SkillStore(env.DB);
    const skill = await importedSkill(skills);
    await skills.delete(skill.id, "user_1");

    expect(await skills.nameAvailable("acme-deploy")).toBe(false);
    expect((await skills.latestImportSource(skill.id))?.commitSha).toBe(source.commitSha);
    expect(await skills.nameAvailable("agent-browser")).toBe(false);
    expect(await skills.nameAvailable("free-name")).toBe(true);
  });
});

describe("managed skill import routes", () => {
  beforeEach(cleanD1Tables);

  it.each([
    ["/skills/import/preview", { source: { repository: { repoOwner: "acme" } } }],
    ["/skills/import", { source: { repository: { repoOwner: "acme", repoName: "skills" } } }],
    [
      "/skills/import/preview",
      { source: { repository: { repoOwner: "acme", repoName: "skills" }, subdirectory: "../etc" } },
    ],
  ])("rejects a malformed body for %s", async (path, body) => {
    const response = await serviceFetch(`https://test.local${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
  });

  it("refuses to re-import a skill that was never imported", async () => {
    const skill = await new SkillStore(env.DB).create(
      { name: "hand-written", content, assignments: [] },
      "user_1"
    );

    const response = await serviceFetch(`https://test.local/skills/${skill.id}/reimport/preview`, {
      method: "POST",
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "This skill was not imported from a repository",
    });
  });

  it("refuses to re-import provenance from a different SCM provider", async () => {
    const skill = await importedSkill(new SkillStore(env.DB));
    await env.DB.prepare(
      "UPDATE skill_import_sources SET provider = 'gitlab' WHERE revision_id = ?"
    )
      .bind(skill.currentRevisionId)
      .run();

    const response = await serviceFetch(`https://test.local/skills/${skill.id}/reimport/preview`, {
      method: "POST",
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "This skill was imported from gitlab, but this deployment uses github",
    });
  });

  it("does not let a linked service actor administer installation-wide skills", async () => {
    await insertCanonicalUser({
      id: "canonical-slack-user",
      email: "linked-slack-user@example.com",
    });
    await insertIdentity({
      id: "slack-skill-admin",
      userId: "canonical-slack-user",
      provider: "slack",
      providerUserId: "U_SKILL_ADMIN",
    });

    const response = await serviceFetch("https://test.local/skills/import/preview", {
      method: "POST",
      service: "slack-bot",
      actor: "slack:U_SKILL_ADMIN",
      body: JSON.stringify({
        source: { repository: { repoOwner: "acme", repoName: "skills" } },
      }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Human user authentication required" });
  });

  it("requires a revision precondition before re-importing", async () => {
    const skill = await importedSkill(new SkillStore(env.DB));

    const response = await serviceFetch(`https://test.local/skills/${skill.id}/reimport`, {
      method: "POST",
      body: JSON.stringify({
        expectedCommitSha: source.commitSha,
        expectedSourceSha256: source.sourceSha256,
        expectedRevisionSha256: "c".repeat(64),
      }),
    });

    expect(response.status).toBe(428);
  });

  it("rejects a stale revision before fetching the source", async () => {
    const skill = await importedSkill(new SkillStore(env.DB));

    const response = await serviceFetch(`https://test.local/skills/${skill.id}/reimport`, {
      method: "POST",
      headers: { "If-Match": "skillrev_stale" },
      body: JSON.stringify({
        expectedCommitSha: source.commitSha,
        expectedSourceSha256: source.sourceSha256,
        expectedRevisionSha256: skill.revisionSha256,
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: `Current revision is ${skill.currentRevisionId}`,
    });
  });

  it("reports the source on the skill returned over HTTP", async () => {
    const skill = await importedSkill(new SkillStore(env.DB));

    const response = await serviceFetch(`https://test.local/skills/${skill.id}`);
    const body = (await response.json()) as { skill: { source: SkillImportSource } };

    expect(response.status).toBe(200);
    expect(body.skill.source).toMatchObject({
      repoOwner: "acme",
      repoName: "skills",
      commitSha: source.commitSha,
      subdirectory: "skills/deploy-service",
    });
  });

  it("returns 404 when the skill does not exist", async () => {
    const response = await serviceFetch(
      "https://test.local/skills/skill_missing/reimport/preview",
      {
        method: "POST",
        body: JSON.stringify({}),
      }
    );

    expect(response.status).toBe(404);
  });
});
