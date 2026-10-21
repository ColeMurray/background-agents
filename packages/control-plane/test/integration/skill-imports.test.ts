import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { SKILL_LIST_PAGE_SIZE, type SkillImportSource } from "@open-inspect/shared/types/skills";
import type { SqlDatabase, SqlStatement } from "../../src/db/sql-database";
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

  it("persists a reviewed collection atomically with shared assignments and provenance", async () => {
    const store = new SkillStore(env.DB);
    const imported = await store.createImportedSkills(
      [
        { name: "deploy-api", content, source },
        {
          name: "deploy-worker",
          content: { ...content, description: "Imported worker deployment instructions" },
          source: {
            ...source,
            subdirectory: "skills/deploy-worker",
            sourceSha256: "c".repeat(64),
          },
        },
      ],
      [
        { type: "global" },
        {
          type: "repository",
          repository: { repoOwner: "Acme", repoName: "API", baseBranch: null },
        },
      ],
      "user_1"
    );

    expect(imported.map((skill) => skill.name)).toEqual(["deploy-api", "deploy-worker"]);
    const stored = await Promise.all(imported.map((skill) => store.get(skill.id)));
    expect(stored.every((skill) => skill?.assignments.length === 2)).toBe(true);
    expect(stored.map((skill) => skill?.source?.subdirectory)).toEqual([
      "skills/deploy-service",
      "skills/deploy-worker",
    ]);
    expect(stored.every((skill) => skill?.source?.revisionId === skill?.currentRevisionId)).toBe(
      true
    );
    expect(await store.catalogGeneration()).toBeGreaterThan(0);
  });

  it("uses the same persisted content and provenance fields for single and bulk imports", async () => {
    const store = new SkillStore(env.DB);
    const richContent = {
      ...content,
      license: "MIT",
      compatibility: "Requires a POSIX shell",
      metadata: { team: "platform", note: "déploiement" },
      files: [
        ...content.files,
        { path: "references/checklist.md", content: "Review ✓\n", executable: false },
      ],
    };
    const pinnedSource: SkillImportSource = {
      ...source,
      provider: "gitlab",
      repoOwner: "group/subgroup",
      requestedRef: "release",
      resolvedRef: "release",
    };
    const assignments = [
      { type: "global" as const },
      {
        type: "repository" as const,
        repository: { repoOwner: "group/subgroup", repoName: "app", baseBranch: null },
      },
    ];
    const single = await store.create(
      { name: "single-import", content: richContent, assignments },
      "user_1",
      pinnedSource
    );
    const [bulk] = await store.createImportedSkills(
      [{ name: "bulk-import", content: richContent, source: pinnedSource }],
      assignments,
      "user_1"
    );
    for (const skill of [single, await store.get(bulk.id)]) {
      expect(skill).toMatchObject({
        description: richContent.description,
        body: richContent.body,
        license: richContent.license,
        compatibility: richContent.compatibility,
        metadata: richContent.metadata,
        createdBy: "user_1",
        updatedBy: "user_1",
        revisionCreatedBy: "user_1",
        revisionNumber: 1,
        enabled: true,
        source: pinnedSource,
        assignments: expect.arrayContaining([
          expect.objectContaining({ type: "global" }),
          expect.objectContaining({
            type: "repository",
            repoOwner: "group/subgroup",
            repoName: "app",
          }),
        ]),
        files: expect.arrayContaining(
          richContent.files.map((file) => expect.objectContaining(file))
        ),
      });
      expect(skill?.source?.revisionId).toBe(skill?.currentRevisionId);
    }
  });

  it("stores none of a collection when any selected name conflicts", async () => {
    const store = new SkillStore(env.DB);
    await importedSkill(store, "already-there");

    await expect(
      store.createImportedSkills(
        [
          { name: "would-be-created", content, source },
          {
            name: "already-there",
            content,
            source: { ...source, subdirectory: "skills/already-there" },
          },
        ],
        [{ type: "global" }],
        "user_1"
      )
    ).rejects.toThrow(SkillConflictError);

    expect(await store.nameAvailable("would-be-created")).toBe(true);
    expect((await store.list({ limit: SKILL_LIST_PAGE_SIZE, cursor: null })).skills).toHaveLength(
      1
    );
  });

  it("rolls back when a name is claimed after availability was checked", async () => {
    const db: SqlDatabase = env.DB;
    const store = new SkillStore(db);
    const racingStore = new SkillStore({
      prepare: (query) => db.prepare(query),
      async batch<T>(statements: SqlStatement[]) {
        await importedSkill(store, "race-taken");
        return db.batch<T>(statements);
      },
    });
    await expect(
      racingStore.createImportedSkills(
        [
          { name: "would-be-created", content, source },
          { name: "race-taken", content, source: { ...source, subdirectory: "skills/race-taken" } },
        ],
        [{ type: "global" }],
        "user_1"
      )
    ).rejects.toThrow(SkillConflictError);
    expect(await store.nameAvailable("would-be-created")).toBe(true);
    expect(
      (await store.list({ limit: SKILL_LIST_PAGE_SIZE, cursor: null })).skills.map(
        (skill) => skill.name
      )
    ).toEqual(["race-taken"]);
    for (const table of ["skill_revisions", "skill_assignments", "skill_import_sources"]) {
      expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).toEqual({
        count: 1,
      });
    }
  });

  it("rolls back the whole collection when a later write fails", async () => {
    const store = new SkillStore(env.DB);
    await env.DB.prepare(
      `CREATE TRIGGER reject_bulk_skill_write
       BEFORE INSERT ON skill_import_sources WHEN NEW.subdirectory = 'skills/write-conflict'
       BEGIN SELECT RAISE(ABORT, 'forced write conflict'); END;`
    ).run();
    try {
      await expect(
        store.createImportedSkills(
          [
            { name: "would-be-created", content, source },
            {
              name: "write-conflict",
              content,
              source: { ...source, subdirectory: "skills/write-conflict" },
            },
          ],
          [{ type: "global" }],
          "user_1"
        )
      ).rejects.toThrow(/forced write conflict/);
    } finally {
      await env.DB.prepare("DROP TRIGGER reject_bulk_skill_write").run();
    }

    expect((await store.list({ limit: SKILL_LIST_PAGE_SIZE, cursor: null })).skills).toEqual([]);
    expect(await store.catalogGeneration()).toBe(0);
    for (const table of [
      "skills",
      "skill_revisions",
      "skill_revision_files",
      "skill_assignments",
      "skill_import_sources",
    ]) {
      expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).toEqual({
        count: 0,
      });
    }
  });

  it("rejects duplicate and reserved collection names before storing any skill", async () => {
    const store = new SkillStore(env.DB);
    await expect(
      store.createImportedSkills(
        [
          { name: "duplicate", content, source },
          { name: "duplicate", content, source: { ...source, subdirectory: "skills/other" } },
        ],
        [],
        "user_1"
      )
    ).rejects.toThrow(/Duplicate skill name/);
    await expect(
      store.createImportedSkills([{ name: "agent-browser", content, source }], [], "user_1")
    ).rejects.toThrow(/reserved/);

    expect((await store.list({ limit: SKILL_LIST_PAGE_SIZE, cursor: null })).skills).toEqual([]);
  });
});

describe("managed skill import routes", () => {
  beforeEach(cleanD1Tables);

  it.each([
    ["/skills/import/preview", { source: { repository: { repoOwner: "acme" } } }],
    ["/skills/import", { source: { repository: { repoOwner: "acme", repoName: "skills" } } }],
    ["/skills/import/bulk/preview", { source: { repository: { repoOwner: "acme" } } }],
    [
      "/skills/import/bulk",
      { source: { repository: { repoOwner: "acme", repoName: "skills" } }, skills: [] },
    ],
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
