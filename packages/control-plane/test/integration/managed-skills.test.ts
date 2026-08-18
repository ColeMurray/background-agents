import { beforeEach, describe, expect, it, vi } from "vitest";
import { env, SELF } from "cloudflare:test";
import { SkillProfileStore } from "../../src/db/skill-profiles";
import { SessionIndexStore } from "../../src/db/session-index";
import { SessionSkillStore } from "../../src/db/session-skills";
import { SkillConflictError, SkillStore } from "../../src/db/skills";
import { EnvironmentStore } from "../../src/db/environments";
import { resolveManagedSkills } from "../../src/session/skill-resolution";
import { buildSkillRevision } from "../../src/skills/content-addressing";
import { cleanD1Tables } from "./cleanup";
import { initNamedSessionDO, seedSandboxAuthHash, serviceFetch } from "./helpers";

const content = {
  description: "Managed deployment instructions",
  body: "# Deployment\n",
  license: null,
  compatibility: null,
  metadata: {},
  files: [{ path: "scripts/deploy.sh", content: "#!/bin/sh\n", executable: true }],
};

describe("managed skills persistence and resolution", () => {
  beforeEach(cleanD1Tables);

  it("creates immutable content, resolves assignments, and filters with an owned profile", async () => {
    const skills = new SkillStore(env.DB);
    const skill = await skills.create(
      {
        name: "acme-deploy",
        content,
        assignments: [
          { type: "global" },
          { type: "repository", repository: { repoOwner: "group/subgroup", repoName: "api" } },
        ],
      },
      "user_1"
    );
    expect(skill.files.find((file) => file.path === "SKILL.md")?.content).toContain(
      "name: acme-deploy"
    );
    expect(skill.files.find((file) => file.path === "scripts/deploy.sh")?.executable).toBe(true);

    const unchanged = await skills.replaceContentAndAssignments(
      skill.id,
      {
        content,
        assignments: [
          { type: "global" },
          { type: "repository", repository: { repoOwner: "group/subgroup", repoName: "api" } },
        ],
      },
      "user_2",
      skill.currentRevisionId
    );
    expect(unchanged?.currentRevisionId).toBe(skill.currentRevisionId);
    expect(unchanged?.revisionNumber).toBe(1);

    const profile = await new SkillProfileStore(env.DB).create("user_1", "Backend", [skill.id]);
    const manifest = await resolveManagedSkills(
      env.DB,
      {
        repositories: [{ repoOwner: "group/subgroup", repoName: "api" }],
        environmentId: null,
      },
      { mode: "profile", profileId: profile.id },
      "user_1"
    );
    expect(manifest.selection).toEqual({
      mode: "profile",
      profileId: profile.id,
      profileName: "Backend",
    });
    expect(manifest.skills).toHaveLength(1);
    expect(manifest.skills[0].assignmentSources).toHaveLength(2);

    await expect(
      resolveManagedSkills(
        env.DB,
        { repositories: [], environmentId: null },
        { mode: "profile", profileId: profile.id },
        "user_2"
      )
    ).rejects.toMatchObject({ status: 404 });
  });

  it("reports concurrent same-name creation as a conflict", async () => {
    const skills = new SkillStore(env.DB);
    const results = await Promise.allSettled([
      skills.create({ name: "same-name", content, assignments: [] }, "user_1"),
      skills.create({ name: "same-name", content, assignments: [] }, "user_2"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: expect.any(SkillConflictError) });
  });

  it("persists a resolved manifest atomically and copies it verbatim to a child", async () => {
    const skill = await new SkillStore(env.DB).create(
      { name: "acme-review", content, assignments: [{ type: "global" }] },
      "user_1"
    );
    const manifest = await resolveManagedSkills(
      env.DB,
      { repositories: [], environmentId: null },
      { mode: "all" },
      "user_1"
    );
    const sessions = new SessionIndexStore(env.DB);
    const base = {
      title: null,
      repoOwner: null,
      repoName: null,
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: null,
      status: "created" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await sessions.create({ ...base, id: "parent", skillManifest: manifest });
    await sessions.create({
      ...base,
      id: "child",
      parentSessionId: "parent",
      skillManifestSourceSessionId: "parent",
    });

    const store = new SessionSkillStore(env.DB);
    const parent = await store.getSessionSkillsView("parent");
    const child = await store.getSessionSkillsView("child");
    expect(child?.manifestSha256).toBe(parent?.manifestSha256);
    expect(child?.selection).toEqual(parent?.selection);
    expect(child?.skills).toEqual(parent?.skills);
    expect(child?.skills[0].skillId).toBe(skill.id);

    const sandboxInstallation = await store.getSandboxInstallation("child");
    expect(sandboxInstallation).not.toHaveProperty("selection");
    expect(Object.keys(sandboxInstallation?.skills[0] ?? {}).sort()).toEqual(["files", "name"]);
    expect(sandboxInstallation?.skills[0].files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "scripts/deploy.sh",
    ]);
    const otherSkill = await new SkillStore(env.DB).create(
      { name: "other-pinned-skill", content, assignments: [] },
      "user_1"
    );
    await expect(
      env.DB.prepare(
        "UPDATE session_skill_revisions SET revision_id = ? WHERE session_id = ? AND skill_id = ?"
      )
        .bind(otherSkill.currentRevisionId, "parent", skill.id)
        .run()
    ).rejects.toThrow(/foreign key/i);
    await env.DB.prepare(
      "UPDATE session_skill_manifests SET resolver_version = 2 WHERE session_id = 'child'"
    ).run();
    await expect(store.getSessionSkillsView("child")).rejects.toThrow(
      "Unsupported managed skill resolver version: 2"
    );
    await env.DB.prepare(
      "UPDATE session_skill_manifests SET resolver_version = 1 WHERE session_id = 'child'"
    ).run();

    const { stub } = await initNamedSessionDO("child");
    await seedSandboxAuthHash(stub, { authToken: "child-sandbox-token", sandboxId: "sandbox-1" });
    const sandboxResponse = await SELF.fetch("https://test.local/sessions/child/sandbox-skills", {
      headers: { Authorization: "Bearer child-sandbox-token" },
    });
    expect(sandboxResponse.status).toBe(200);
    expect(sandboxResponse.headers.get("ETag")).toBe(`"${manifest.manifestSha256}"`);

    const wrongSessionResponse = await SELF.fetch(
      "https://test.local/sessions/parent/sandbox-skills",
      { headers: { Authorization: "Bearer child-sandbox-token" } }
    );
    expect(wrongSessionResponse.status).toBe(401);

    const humanResponse = await serviceFetch("https://test.local/sessions/child/skills");
    expect(humanResponse.status).toBe(200);
    await expect(humanResponse.json()).resolves.toMatchObject({
      manifestSha256: manifest.manifestSha256,
      selection: { mode: "all" },
    });

    await env.DB.prepare(
      "DELETE FROM skill_revision_files WHERE revision_id = ? AND path = 'SKILL.md'"
    )
      .bind(skill.currentRevisionId)
      .run();
    await expect(store.getSandboxInstallation("child")).rejects.toThrow(
      `Missing files for session skill revision ${skill.currentRevisionId}`
    );
  });

  it("serves catalog and personal profile CRUD through authenticated routes", async () => {
    const createResponse = await serviceFetch("https://test.local/skills", {
      method: "POST",
      body: JSON.stringify({
        name: "acme-route-skill",
        content,
        assignments: [{ type: "global" }],
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json<{ skill: { id: string; createdBy: string } }>();
    expect(created.skill.createdBy).toBe("11111111111111111111111111111111");

    const disabled = await serviceFetch(`https://test.local/skills/${created.skill.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.status).toBe(200);
    await expect(disabled.json()).resolves.toMatchObject({ skill: { enabled: false } });

    const assignmentsThroughPatch = await serviceFetch(
      `https://test.local/skills/${created.skill.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ assignments: [] }),
      }
    );
    expect(assignmentsThroughPatch.status).toBe(400);

    const profileResponse = await serviceFetch("https://test.local/skill-profiles", {
      method: "POST",
      body: JSON.stringify({ name: "My skills", skillIds: [created.skill.id] }),
    });
    expect(profileResponse.status).toBe(201);
    const profiles = await serviceFetch("https://test.local/skill-profiles");
    await expect(profiles.json()).resolves.toMatchObject({
      profiles: [{ name: "My skills", skillIds: [created.skill.id] }],
    });

    const deleteResponse = await serviceFetch(`https://test.local/skills/${created.skill.id}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);
    const getResponse = await serviceFetch(`https://test.local/skills/${created.skill.id}`);
    expect(getResponse.status).toBe(404);
  });

  it("paginates catalogs and hydrates assignments beyond D1's parameter limit", async () => {
    const skills = new SkillStore(env.DB);
    const catalog = await Promise.all(
      Array.from({ length: 101 }, async (_, index) => {
        const suffix = String(index).padStart(3, "0");
        const id = `catalog-skill-${suffix}`;
        return {
          id,
          revisionId: `catalog-revision-${suffix}`,
          revision: await buildSkillRevision(id, content),
        };
      })
    );
    const phases = [
      catalog.map(({ id }) =>
        env.DB.prepare(
          `INSERT INTO skills
           (id, name, enabled, created_by, updated_by, created_at, updated_at)
           VALUES (?, ?, 1, 'user_1', 'user_1', 1, 1)`
        ).bind(id, id)
      ),
      catalog.map(({ id, revisionId, revision }) =>
        env.DB.prepare(
          `INSERT INTO skill_revisions
           (id, skill_id, revision_number, revision_sha256, description, body,
            metadata_json, total_bytes, created_by, created_at)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'user_1', 1)`
        ).bind(
          revisionId,
          id,
          revision.revisionSha256,
          content.description,
          content.body,
          JSON.stringify(content.metadata),
          revision.totalBytes
        )
      ),
      catalog.flatMap(({ revisionId, revision }) =>
        revision.files.map((file) =>
          env.DB.prepare(
            `INSERT INTO skill_revision_files
             (revision_id, path, content, content_sha256, size_bytes, executable)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(
            revisionId,
            file.path,
            file.content,
            file.sha256,
            file.sizeBytes,
            file.executable ? 1 : 0
          )
        )
      ),
      catalog.map(({ id, revisionId }) =>
        env.DB.prepare("UPDATE skills SET current_revision_id = ? WHERE id = ?").bind(
          revisionId,
          id
        )
      ),
      catalog.map(({ id }) =>
        env.DB.prepare(
          `INSERT INTO skill_assignments
           (id, skill_id, scope_type, created_by, created_at)
           VALUES (?, ?, 'global', 'user_1', 1)`
        ).bind(`catalog-assignment-${id}`, id)
      ),
    ];
    for (const phase of phases) {
      for (let start = 0; start < phase.length; start += 100) {
        await env.DB.batch(phase.slice(start, start + 100));
      }
    }

    const applicable = await skills.listApplicable({ repositories: [], environmentId: null });
    expect(applicable).toHaveLength(101);
    expect(applicable.every((skill) => skill.assignments[0]?.type === "global")).toBe(true);

    const firstResponse = await serviceFetch("https://test.local/skills?limit=100");
    expect(firstResponse.status).toBe(200);
    const firstPage = await firstResponse.json<{
      skills: { name: string }[];
      hasMore: boolean;
      nextCursor: string | null;
    }>();
    expect(firstPage.skills).toHaveLength(100);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toBe("catalog-skill-099");

    const secondResponse = await serviceFetch(
      `https://test.local/skills?limit=100&cursor=${firstPage.nextCursor}`
    );
    await expect(secondResponse.json()).resolves.toMatchObject({
      skills: [{ name: "catalog-skill-100" }],
      hasMore: false,
      nextCursor: null,
    });
  });

  it("maps typed profile validation and conflict failures", async () => {
    const first = await serviceFetch("https://test.local/skill-profiles", {
      method: "POST",
      body: JSON.stringify({ name: "Duplicate", skillIds: [] }),
    });
    expect(first.status).toBe(201);
    const conflict = await serviceFetch("https://test.local/skill-profiles", {
      method: "POST",
      body: JSON.stringify({ name: "Duplicate", skillIds: [] }),
    });
    expect(conflict.status).toBe(409);
    const invalid = await serviceFetch("https://test.local/skill-profiles", {
      method: "POST",
      body: JSON.stringify({ name: "Invalid", skillIds: ["missing_skill"] }),
    });
    expect(invalid.status).toBe(400);
  });

  it("edits content and assignments atomically with a required revision precondition", async () => {
    const skill = await new SkillStore(env.DB).create(
      { name: "atomic-edit", content, assignments: [{ type: "global" }] },
      "user_1"
    );
    const missingPrecondition = await serviceFetch(`https://test.local/skills/${skill.id}`, {
      method: "PUT",
      body: JSON.stringify({ content, assignments: [] }),
    });
    expect(missingPrecondition.status).toBe(428);

    const invalidAssignment = await serviceFetch(`https://test.local/skills/${skill.id}`, {
      method: "PUT",
      headers: { "If-Match": skill.currentRevisionId },
      body: JSON.stringify({
        content: { ...content, body: "changed" },
        assignments: [{ type: "environment", environmentId: "missing" }],
      }),
    });
    expect(invalidAssignment.status).toBe(400);
    const unchanged = await new SkillStore(env.DB).get(skill.id);
    expect(unchanged?.revisionNumber).toBe(1);
    expect(unchanged?.body).toBe(content.body);
    expect(unchanged?.assignments).toMatchObject([{ type: "global" }]);

    const enabledThroughPut = await serviceFetch(`https://test.local/skills/${skill.id}`, {
      method: "PUT",
      headers: { "If-Match": skill.currentRevisionId },
      body: JSON.stringify({ content, assignments: [], enabled: false }),
    });
    expect(enabledThroughPut.status).toBe(400);

    const edited = await serviceFetch(`https://test.local/skills/${skill.id}`, {
      method: "PUT",
      headers: { "If-Match": skill.currentRevisionId },
      body: JSON.stringify({ content: { ...content, body: "changed" }, assignments: [] }),
    });
    expect(edited.status).toBe(200);
    await expect(edited.json()).resolves.toMatchObject({
      skill: { body: "changed", revisionNumber: 2, assignments: [] },
    });
  });

  it("leaves revisions, assignments, and generation unchanged when a combined edit CAS is stale", async () => {
    const skills = new SkillStore(env.DB);
    const skill = await skills.create(
      { name: "stale-atomic-edit", content, assignments: [{ type: "global" }] },
      "user_1"
    );
    const originalBatch = env.DB.batch.bind(env.DB);
    let generationAfterWinningEdit = 0;
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      const winningStore = new SkillStore(env.DB);
      await winningStore.replaceContentAndAssignments(
        skill.id,
        { content: { ...content, body: "winning edit" }, assignments: [{ type: "global" }] },
        "user_2",
        skill.currentRevisionId
      );
      generationAfterWinningEdit = await winningStore.catalogGeneration();
      return originalBatch(statements);
    });

    await expect(
      skills.replaceContentAndAssignments(
        skill.id,
        { content: { ...content, body: "stale edit" }, assignments: [] },
        "user_1",
        skill.currentRevisionId
      )
    ).rejects.toThrow("Skill changed concurrently");

    expect(await skills.catalogGeneration()).toBe(generationAfterWinningEdit);
    const revisionCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM skill_revisions WHERE skill_id = ?"
    )
      .bind(skill.id)
      .first<{ count: number }>();
    expect(revisionCount?.count).toBe(2);
    expect((await skills.get(skill.id))?.assignments).toMatchObject([{ type: "global" }]);
  });

  it("tracks environment assignment provenance changes through database-owned triggers", async () => {
    const environments = new EnvironmentStore(env.DB);
    await environments.create(
      {
        id: "env_skill_generation",
        name: "Before",
        description: null,
        prebuild_enabled: 0,
        channel_associations: null,
        created_at: 1,
        updated_at: 1,
      },
      []
    );
    const skills = new SkillStore(env.DB);
    const skill = await skills.create(
      {
        name: "environment-trigger",
        content,
        assignments: [{ type: "environment", environmentId: "env_skill_generation" }],
      },
      "user_1"
    );
    const beforeRename = await skills.catalogGeneration();
    await environments.update("env_skill_generation", { name: "After" });
    expect(await skills.catalogGeneration()).toBe(beforeRename + 1);

    const beforeDelete = await skills.catalogGeneration();
    await environments.delete("env_skill_generation");
    expect(await skills.catalogGeneration()).toBeGreaterThan(beforeDelete);
    expect((await skills.get(skill.id))?.assignments).toEqual([]);
  });

  it("enforces same-skill current revisions and reports ignored profile references", async () => {
    const skills = new SkillStore(env.DB);
    const first = await skills.create(
      { name: "first-skill", content, assignments: [{ type: "global" }] },
      "user_1"
    );
    const second = await skills.create(
      { name: "second-skill", content, assignments: [] },
      "user_1"
    );
    await expect(
      env.DB.prepare("UPDATE skills SET current_revision_id = ? WHERE id = ?")
        .bind(second.currentRevisionId, first.id)
        .run()
    ).rejects.toThrow(/current revision must belong to skill/);
    await expect(
      env.DB.prepare(
        `INSERT INTO skills
         (id, name, current_revision_id, enabled, created_by, updated_by, created_at, updated_at)
         VALUES ('bad_insert', 'bad-insert', 'missing_revision', 1, 'user_1', 'user_1', 1, 1)`
      ).run()
    ).rejects.toThrow(/current revision must belong to skill/);

    const profile = await new SkillProfileStore(env.DB).create("user_1", "Mixed", [
      first.id,
      second.id,
    ]);
    const manifest = await resolveManagedSkills(
      env.DB,
      { repositories: [], environmentId: null },
      { mode: "profile", profileId: profile.id },
      "user_1"
    );
    expect(manifest.skills.map((item) => item.skillId)).toEqual([first.id]);
    expect(manifest.ignoredProfileSkillIds).toEqual([second.id]);
  });
});
