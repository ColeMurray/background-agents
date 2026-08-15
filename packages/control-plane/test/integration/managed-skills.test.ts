import { beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { SkillProfileStore } from "../../src/db/skill-profiles";
import { SessionIndexStore } from "../../src/db/session-index";
import { SessionSkillStore } from "../../src/db/session-skills";
import { SkillStore } from "../../src/db/skills";
import { resolveManagedSkills } from "../../src/session/skill-resolution";
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

    const unchanged = await skills.updateContent(
      skill.id,
      content,
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
    const parent = await store.getHumanManifest("parent");
    const child = await store.getHumanManifest("child");
    expect(child?.manifestSha256).toBe(parent?.manifestSha256);
    expect(child?.selection).toEqual(parent?.selection);
    expect(child?.skills).toEqual(parent?.skills);
    expect(child?.skills[0].skillId).toBe(skill.id);

    const sandboxManifest = await store.getSandboxManifest("child");
    expect(sandboxManifest?.skills[0].files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "scripts/deploy.sh",
    ]);
    await expect(
      store.reportActivation("child", {
        manifestSha256: manifest.manifestSha256,
        status: "activated",
      })
    ).resolves.toBe("updated");
    await expect(
      store.reportActivation("child", {
        manifestSha256: manifest.manifestSha256,
        status: "activated",
      })
    ).resolves.toBe("unchanged");

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
