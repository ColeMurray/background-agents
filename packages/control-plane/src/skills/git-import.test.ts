import { describe, expect, it, vi } from "vitest";
import {
  MAX_BULK_SKILL_IMPORT_BYTES,
  MAX_BULK_SKILL_IMPORT_FILES,
  MAX_BULK_SKILL_IMPORT_SKILLS,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_REVISION_BYTES,
  skillImportSourceInputSchema,
} from "@open-inspect/shared/types/skills";
import type { GetRepositoryConfig, RepositoryReader, RepositoryTree } from "../source-control";
import { SourceControlProviderError } from "../source-control";
import {
  fetchBulkSkillImport,
  fetchSelectedBulkSkillImport,
  fetchSkillImport,
  SkillImportError,
} from "./git-import";

const COMMIT = "a".repeat(40);

interface FakeFile {
  content: string | Uint8Array;
  executable?: boolean;
}

/**
 * Minimal repository stand-in. Only the four methods an import calls are
 * implemented; anything else reaching this double is a bug in the importer.
 */
function fakeProvider(
  files: Record<string, FakeFile>,
  overrides: {
    accessible?: boolean;
    commit?: string | null;
    truncated?: boolean;
    defaultBranch?: string;
    otherEntries?: string[];
    /** Mimic GitLab, whose tree listing reports no blob sizes. */
    sizelessTree?: boolean;
    normalizedIdentity?: { repoOwner: string; repoName: string };
    blobLimits?: number[];
    listedPaths?: (string | null | undefined)[];
    calls?: { access: number; resolve: number; tree: number; blobs: number };
  } = {}
): RepositoryReader {
  const encoder = new TextEncoder();
  const blobs = new Map<string, Uint8Array>();
  const entries: RepositoryTree["entries"] = [];
  for (const [path, file] of Object.entries(files)) {
    const blobId = `blob-${path}`;
    const bytes = typeof file.content === "string" ? encoder.encode(file.content) : file.content;
    blobs.set(blobId, bytes);
    entries.push({
      path,
      type: "file",
      blobId,
      sizeBytes: overrides.sizelessTree ? null : bytes.byteLength,
      executable: file.executable ?? false,
    });
  }
  for (const path of overrides.otherEntries ?? []) {
    entries.push({
      path,
      type: "other",
      blobId: `other-${path}`,
      sizeBytes: null,
      executable: false,
    });
  }
  const importSurface: RepositoryReader = {
    name: "github",
    checkRepositoryAccess: async (config: GetRepositoryConfig) => {
      if (overrides.calls) overrides.calls.access++;
      return overrides.accessible === false
        ? null
        : {
            repoId: 1,
            repoOwner: overrides.normalizedIdentity?.repoOwner ?? config.owner,
            repoName: overrides.normalizedIdentity?.repoName ?? config.name,
            defaultBranch: overrides.defaultBranch ?? "main",
          };
    },
    resolveCommit: async () => {
      if (overrides.calls) overrides.calls.resolve++;
      return overrides.commit === null ? null : { sha: overrides.commit ?? COMMIT };
    },
    listTree: async ({ path }) => {
      if (overrides.calls) overrides.calls.tree++;
      overrides.listedPaths?.push(path);
      return { entries, truncated: overrides.truncated ?? false };
    },
    readBlob: async ({ blobId, maxBytes }) => {
      if (overrides.calls) overrides.calls.blobs++;
      overrides.blobLimits?.push(maxBytes);
      const bytes = blobs.get(blobId);
      if (!bytes) throw new Error(`missing blob ${blobId}`);
      return bytes;
    },
  };
  return importSurface;
}

function source(input: { subdirectory?: string; ref?: string } = {}) {
  return skillImportSourceInputSchema.parse({
    repository: { repoOwner: "Acme", repoName: "Skills" },
    ...input,
  });
}

const SKILL_MD = [
  "---",
  "name: deploy-service",
  "description: Deploys the API",
  "---",
  "# Deploy",
  "",
].join("\n");

describe("fetchSkillImport", () => {
  it("imports the workspace catalog with installation-wide content access", async () => {
    const provider = fakeProvider({ "SKILL.md": { content: SKILL_MD } });
    const resolveCommit = vi.spyOn(provider, "resolveCommit");
    const listTree = vi.spyOn(provider, "listTree");
    const readBlob = vi.spyOn(provider, "readBlob");
    await fetchSkillImport(provider, source());
    for (const method of [resolveCommit, listTree, readBlob]) {
      expect(method).toHaveBeenCalledWith(expect.any(Object), { kind: "all" });
    }
  });

  it("reuses the repository resolution already authorized by the route", async () => {
    const provider = fakeProvider({ "SKILL.md": { content: SKILL_MD } });
    const check = vi.spyOn(provider, "checkRepositoryAccess");
    const resolveCommit = vi.spyOn(provider, "resolveCommit");
    const result = await fetchSkillImport(provider, source(), undefined, {
      repoId: 123,
      repoOwner: "canonical-owner",
      repoName: "canonical-name",
      defaultBranch: "develop",
    });
    expect(check).not.toHaveBeenCalled();
    expect(resolveCommit).toHaveBeenCalledWith(
      {
        owner: "canonical-owner",
        name: "canonical-name",
        ref: "develop",
      },
      { kind: "all" }
    );
    expect(result.source).toMatchObject({
      repoOwner: "canonical-owner",
      repoName: "canonical-name",
      resolvedRef: "develop",
    });
  });

  it("maps SKILL.md and supporting files onto a validated revision", async () => {
    const provider = fakeProvider({
      "SKILL.md": { content: SKILL_MD },
      "scripts/deploy.sh": { content: "#!/bin/sh\n", executable: true },
      "references/runbook.md": { content: "steps\n" },
    });

    const result = await fetchSkillImport(provider, source());

    expect(result.name).toBe("deploy-service");
    expect(result.content.description).toBe("Deploys the API");
    expect(result.content.body).toBe("# Deploy\n");
    expect(result.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "references/runbook.md",
      "scripts/deploy.sh",
    ]);
    expect(result.files.find((file) => file.path === "scripts/deploy.sh")?.executable).toBe(true);
    expect(result.files.find((file) => file.path === "scripts/deploy.sh")?.content).toBe(
      "#!/bin/sh\n"
    );
    expect(result.warnings).toEqual([]);
    expect(result.source).toMatchObject({
      provider: "github",
      repoOwner: "acme",
      repoName: "skills",
      requestedRef: null,
      resolvedRef: "main",
      commitSha: COMMIT,
      subdirectory: null,
    });
  });

  it("distinguishes the source digest from the stored revision digest", async () => {
    const provider = fakeProvider({ "SKILL.md": { content: SKILL_MD } });

    const result = await fetchSkillImport(provider, source());

    expect(result.source.sourceSha256).not.toBe(result.revisionSha256);
    const storedMarkdown = result.files.find((file) => file.path === "SKILL.md")?.content;
    expect(storedMarkdown).not.toBe(SKILL_MD);
    expect(storedMarkdown).toContain("name: deploy-service");
  });

  it("reads a skill from a subdirectory and strips the prefix from paths", async () => {
    const listedPaths: (string | null | undefined)[] = [];
    const provider = fakeProvider(
      {
        "README.md": { content: "repo readme\n" },
        "skills/deploy-service/SKILL.md": { content: SKILL_MD },
        "skills/deploy-service/references/runbook.md": { content: "steps\n" },
      },
      { listedPaths }
    );

    const result = await fetchSkillImport(
      provider,
      source({ subdirectory: "skills/deploy-service" })
    );

    expect(result.files.map((file) => file.path)).toEqual(["SKILL.md", "references/runbook.md"]);
    expect(result.source.subdirectory).toBe("skills/deploy-service");
    expect(listedPaths).toEqual(["skills/deploy-service"]);
  });

  it("names the skill directories it found when the target has no SKILL.md", async () => {
    const provider = fakeProvider({
      "skills/deploy-service/SKILL.md": { content: SKILL_MD },
      "skills/review/SKILL.md": { content: SKILL_MD },
    });

    await expect(fetchSkillImport(provider, source())).rejects.toThrow(
      /No SKILL\.md in acme\/skills\. Skills found in: skills\/deploy-service, skills\/review/
    );
  });

  it("prefers an explicit name and reports the override", async () => {
    const provider = fakeProvider({ "SKILL.md": { content: SKILL_MD } });

    const result = await fetchSkillImport(provider, source(), "acme-deploy");

    expect(result.name).toBe("acme-deploy");
    expect(result.warnings).toEqual([
      {
        code: "name-overridden",
        message: 'Stored as "acme-deploy"; SKILL.md names this skill "deploy-service"',
      },
    ]);
  });

  it("derives a name from the source path when the frontmatter has none", async () => {
    const provider = fakeProvider({
      "skills/deploy-service/SKILL.md": {
        content: "---\ndescription: Deploys the API\n---\n# Deploy\n",
      },
    });

    const result = await fetchSkillImport(
      provider,
      source({ subdirectory: "skills/deploy-service" })
    );

    expect(result.name).toBe("deploy-service");
    expect(result.warnings).toEqual([
      {
        code: "name-derived",
        message: 'SKILL.md has no name; "deploy-service" was derived from the source path',
      },
    ]);
  });

  it("derives an unnamed skill from the requested alias while reading the canonical repository", async () => {
    const provider = fakeProvider(
      { "SKILL.md": { content: "---\ndescription: Deploys the API\n---\n# Deploy\n" } },
      { normalizedIdentity: { repoOwner: "canonical-owner", repoName: "renamed-skills" } }
    );
    const resolveCommit = vi.spyOn(provider, "resolveCommit");
    const listTree = vi.spyOn(provider, "listTree");
    const readBlob = vi.spyOn(provider, "readBlob");

    const result = await fetchSkillImport(provider, source());

    expect(result.name).toBe("skills");
    expect(result.source).toMatchObject({
      repoOwner: "canonical-owner",
      repoName: "renamed-skills",
    });
    for (const read of [resolveCommit, listTree, readBlob]) {
      expect(read).toHaveBeenCalledWith(
        expect.objectContaining({ owner: "canonical-owner", name: "renamed-skills" }),
        { kind: "all" }
      );
    }
  });

  it("surfaces frontmatter that has no managed-skill field", async () => {
    const provider = fakeProvider({
      "SKILL.md": {
        content:
          "---\nname: deploy-service\ndescription: Deploys\nallowed-tools: [read]\nextension:\n  permissions:\n    - deploy\n---\nbody\n",
      },
    });

    const result = await fetchSkillImport(provider, source());

    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "unmapped-frontmatter",
      "unmapped-frontmatter",
    ]);
    expect(result.warnings[0].message).toContain("allowed-tools");
    expect(result.warnings[1].message).toContain("extension");
  });

  it("carries license, compatibility, and metadata across", async () => {
    const provider = fakeProvider({
      "SKILL.md": {
        content: [
          "---",
          "name: deploy-service",
          "description: Deploys",
          "license: Apache-2.0",
          "compatibility: Requires kubectl",
          "metadata:",
          "  team owner: platform",
          "---",
          "body",
          "",
        ].join("\n"),
      },
    });

    const result = await fetchSkillImport(provider, source());

    expect(result.content.license).toBe("Apache-2.0");
    expect(result.content.compatibility).toBe("Requires kubectl");
    expect(result.content.metadata).toEqual({ "team owner": "platform" });
  });

  it.each([
    [
      "an inaccessible repository",
      () => fakeProvider({}, { accessible: false }),
      /not accessible to this installation/,
      404,
    ],
    [
      "a missing ref",
      () => fakeProvider({ "SKILL.md": { content: SKILL_MD } }, { commit: null }),
      /has no branch, tag, or commit "main"/,
      404,
    ],
    [
      "a truncated listing",
      () => fakeProvider({ "SKILL.md": { content: SKILL_MD } }, { truncated: true }),
      /too large to list completely/,
      400,
    ],
    [
      "a binary supporting file",
      () =>
        fakeProvider({
          "SKILL.md": { content: SKILL_MD },
          "assets/logo.png": { content: Uint8Array.of(0x89, 0x50, 0x4e, 0xff, 0xfe) },
        }),
      /assets\/logo\.png is not UTF-8 text/,
      400,
    ],
    [
      "an executable outside scripts/",
      () =>
        fakeProvider({
          "SKILL.md": { content: SKILL_MD },
          "bin/tool.sh": { content: "#!/bin/sh\n", executable: true },
        }),
      /bin\/tool\.sh cannot be imported/,
      400,
    ],
    [
      "a symlink",
      () =>
        fakeProvider({ "SKILL.md": { content: SKILL_MD } }, { otherEntries: ["references/link"] }),
      /references\/link is a symlink or submodule/,
      400,
    ],
    [
      "frontmatter without a description",
      () => fakeProvider({ "SKILL.md": { content: "---\nname: deploy-service\n---\nbody\n" } }),
      /has no description/,
      400,
    ],
    [
      "unreadable frontmatter",
      () => fakeProvider({ "SKILL.md": { content: "# Deploy\n" } }),
      /SKILL\.md frontmatter is invalid/,
      400,
    ],
    [
      "a name that is not a canonical name",
      () =>
        fakeProvider({
          "SKILL.md": { content: "---\nname: Deploy Service\ndescription: d\n---\n" },
        }),
      /is not a valid canonical name/,
      400,
    ],
  ])("rejects %s", async (_case, build, message, status) => {
    const error = await fetchSkillImport(build(), source()).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SkillImportError);
    expect((error as SkillImportError).message).toMatch(message);
    expect((error as SkillImportError).status).toBe(status);
  });

  it("records the provider's normalized repository identity, not the request's", async () => {
    const provider = fakeProvider(
      { "SKILL.md": { content: SKILL_MD } },
      { normalizedIdentity: { repoOwner: "acme-group/platform", repoName: "skills" } }
    );

    const result = await fetchSkillImport(provider, source());

    expect(result.source.repoOwner).toBe("acme-group/platform");
    expect(result.source.repoName).toBe("skills");
  });

  it("tells the provider the per-file limit so it can refuse before buffering", async () => {
    const blobLimits: number[] = [];
    const provider = fakeProvider({ "SKILL.md": { content: SKILL_MD } }, { blobLimits });

    await fetchSkillImport(provider, source());

    expect(blobLimits).toEqual([MAX_SKILL_FILE_BYTES]);
  });

  it("reports an upstream blob-limit rejection as an import validation error", async () => {
    const provider = fakeProvider({ "SKILL.md": { content: SKILL_MD } });
    provider.readBlob = async () => {
      throw new SourceControlProviderError("Blob is over the limit", "permanent", 413);
    };

    const error = await fetchSkillImport(provider, source()).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SkillImportError);
    expect((error as SkillImportError).status).toBe(400);
  });

  it("enforces the revision limit on a tree that reports no sizes", async () => {
    const half = "x".repeat(200 * 1024);
    const provider = fakeProvider(
      {
        "SKILL.md": { content: SKILL_MD },
        "references/a.md": { content: half },
        "references/b.md": { content: half },
        "references/c.md": { content: half },
        "references/d.md": { content: half },
        "references/e.md": { content: half },
        "references/f.md": { content: half },
      },
      { sizelessTree: true }
    );

    await expect(fetchSkillImport(provider, source())).rejects.toThrow(
      new RegExp(`Imported content exceeds the ${MAX_SKILL_REVISION_BYTES}-byte skill limit`)
    );
  });

  it("rejects an oversized SKILL.md from the declared sizes alone", async () => {
    const blobLimits: number[] = [];
    const provider = fakeProvider(
      { "SKILL.md": { content: `${SKILL_MD}${"x".repeat(MAX_SKILL_REVISION_BYTES)}` } },
      { blobLimits }
    );

    await expect(fetchSkillImport(provider, source())).rejects.toThrow(
      new RegExp(`exceeds the ${MAX_SKILL_REVISION_BYTES}-byte skill limit`)
    );
    expect(blobLimits).toEqual([]);
  });

  it("rejects a file over the per-file size limit", async () => {
    const provider = fakeProvider({
      "SKILL.md": { content: SKILL_MD },
      "references/big.md": { content: "x".repeat(MAX_SKILL_FILE_BYTES + 1) },
    });

    await expect(fetchSkillImport(provider, source())).rejects.toThrow(
      new RegExp(
        `references/big\\.md is ${MAX_SKILL_FILE_BYTES + 1} bytes, ` +
          `over the ${MAX_SKILL_FILE_BYTES}-byte per-file limit`
      )
    );
  });
});

describe("fetchBulkSkillImport", () => {
  it("maps a 64-skill collection deterministically from one resolved tree", async () => {
    const calls = { access: 0, resolve: 0, tree: 0, blobs: 0 };
    const files: Record<string, FakeFile> = {};
    for (let index = 63; index >= 0; index--) {
      const name = `skill-${index.toString().padStart(2, "0")}`;
      const root = `catalog/${name}`;
      files[`${root}/SKILL.md`] = {
        content: `---\nname: ${name}\ndescription: Skill ${index}\n---\nbody\n`,
      };
      const supportingCount = index < 37 ? 3 : 2;
      for (let file = supportingCount - 1; file >= 0; file--) {
        files[`${root}/references/file-${file}.md`] = { content: "x".repeat(9_500) };
      }
    }
    const expectedBytes = Object.values(files).reduce(
      (total, file) =>
        total +
        (typeof file.content === "string"
          ? new TextEncoder().encode(file.content).byteLength
          : file.content.byteLength),
      0
    );

    const result = await fetchBulkSkillImport(
      fakeProvider(files, { calls }),
      source({ subdirectory: "catalog", ref: "release" })
    );

    expect(result.skills).toHaveLength(64);
    expect(result.totalFiles).toBe(229);
    expect(result.totalBytes).toBe(expectedBytes);
    expect(result.skills.map((skill) => skill.name)).toEqual(
      Array.from({ length: 64 }, (_, index) => `skill-${index.toString().padStart(2, "0")}`)
    );
    expect(result.skills[0].source).toMatchObject({
      requestedRef: "release",
      resolvedRef: "release",
      commitSha: COMMIT,
      subdirectory: "catalog/skill-00",
    });
    expect(calls).toEqual({ access: 1, resolve: 1, tree: 1, blobs: 229 });
  });

  it("shares a bounded blob queue across independent skill roots", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `catalog/skill-${String(index).padStart(2, "0")}/SKILL.md`,
        { content: `---\nname: skill-${index}\ndescription: Skill ${index}\n---\nbody\n` },
      ]).reverse()
    );
    const provider = fakeProvider(files);
    const readBlob = provider.readBlob.bind(provider);
    let active = 0;
    let peak = 0;
    provider.readBlob = async (...args) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return await readBlob(...args);
      } finally {
        active--;
      }
    };
    const result = await fetchBulkSkillImport(provider, source({ subdirectory: "catalog" }));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);
    expect(result.skills.map((skill) => skill.name)).toEqual(
      Array.from({ length: 12 }, (_, index) => `skill-${index}`)
    );
  });

  it("preserves per-skill name and frontmatter warnings", async () => {
    const result = await fetchBulkSkillImport(
      fakeProvider({
        "catalog/derived-name/SKILL.md": {
          content: "---\ndescription: Derived\nallowed-tools: read\n---\nbody\n",
        },
      }),
      source({ subdirectory: "catalog" })
    );

    expect(result.skills[0].name).toBe("derived-name");
    expect(result.skills[0].warnings.map((warning) => warning.code)).toEqual([
      "unmapped-frontmatter",
      "name-derived",
    ]);
  });

  it.each([
    ["an empty prefix", fakeProvider({}), /No skills found/, 404],
    [
      "a truncated tree",
      fakeProvider({ "catalog/a/SKILL.md": { content: SKILL_MD } }, { truncated: true }),
      /too large to list completely/,
      400,
    ],
    [
      "nested skill roots",
      fakeProvider({
        "catalog/parent/SKILL.md": { content: SKILL_MD },
        "catalog/parent/child/SKILL.md": { content: SKILL_MD },
      }),
      /Nested skill roots are not supported/,
      400,
    ],
  ])("rejects %s", async (_case, provider, message, status) => {
    const error = await fetchBulkSkillImport(provider, source({ subdirectory: "catalog" })).catch(
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(SkillImportError);
    expect((error as SkillImportError).message).toMatch(message);
    expect((error as SkillImportError).status).toBe(status);
  });

  it("rejects the aggregate skill limit before reading blobs", async () => {
    const blobLimits: number[] = [];
    const files = Object.fromEntries(
      Array.from({ length: MAX_BULK_SKILL_IMPORT_SKILLS + 1 }, (_, index) => [
        `catalog/skill-${index}/SKILL.md`,
        { content: SKILL_MD },
      ])
    );

    await expect(
      fetchBulkSkillImport(fakeProvider(files, { blobLimits }), source({ subdirectory: "catalog" }))
    ).rejects.toThrow(new RegExp(`${MAX_BULK_SKILL_IMPORT_SKILLS}-skill aggregate limit`));
    expect(blobLimits).toEqual([]);
  });

  it.each([
    ["unsafe", "catalog/../escape"],
    ["deep", `catalog/${Array.from({ length: 20 }, (_, index) => `d${index}`).join("/")}`],
    ["long", `catalog/${"x".repeat(241)}`],
  ])("rejects a %s discovered skill root", async (_case, root) => {
    const error = await fetchBulkSkillImport(
      fakeProvider({ [`${root}/SKILL.md`]: { content: SKILL_MD } }),
      source({ subdirectory: "catalog" })
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SkillImportError);
    expect((error as SkillImportError).status).toBe(400);
    expect((error as SkillImportError).message).toMatch(/not a safe relative POSIX path/);
  });

  it("rejects discovered roots that change when parsed before reading blobs", async () => {
    const root = "catalog/deploy ";
    const blobLimits: number[] = [];
    const provider = fakeProvider({ [`${root}/SKILL.md`]: { content: SKILL_MD } }, { blobLimits });

    await expect(
      fetchBulkSkillImport(provider, source({ subdirectory: "catalog" }))
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("leading or trailing whitespace"),
    });
    expect(blobLimits).toEqual([]);
  });

  it("rejects the aggregate file limit before reading blobs", async () => {
    const blobLimits: number[] = [];
    const files: Record<string, FakeFile> = {};
    for (let skill = 0; skill < 6; skill++) {
      const root = `catalog/skill-${skill}`;
      files[`${root}/SKILL.md`] = { content: SKILL_MD };
      for (let file = 0; file < 83; file++) {
        files[`${root}/references/${file}.md`] = { content: "x" };
      }
    }
    expect(Object.keys(files).length).toBeGreaterThan(MAX_BULK_SKILL_IMPORT_FILES);

    await expect(
      fetchBulkSkillImport(fakeProvider(files, { blobLimits }), source({ subdirectory: "catalog" }))
    ).rejects.toThrow(new RegExp(`${MAX_BULK_SKILL_IMPORT_FILES}-file aggregate limit`));
    expect(blobLimits).toEqual([]);
  });

  it("rejects the aggregate byte limit before reading blobs", async () => {
    const blobLimits: number[] = [];
    const files: Record<string, FakeFile> = {};
    for (let skill = 0; skill < 10; skill++) {
      const root = `catalog/skill-${skill}`;
      files[`${root}/SKILL.md`] = { content: SKILL_MD };
      for (let file = 0; file < 4; file++) {
        files[`${root}/references/${file}.md`] = { content: "x".repeat(220 * 1024) };
      }
    }

    await expect(
      fetchBulkSkillImport(fakeProvider(files, { blobLimits }), source({ subdirectory: "catalog" }))
    ).rejects.toThrow(new RegExp(`${MAX_BULK_SKILL_IMPORT_BYTES}-byte aggregate limit`));
    expect(blobLimits).toEqual([]);
  });

  it("enforces the aggregate byte limit when tree sizes are unavailable", async () => {
    const calls = { access: 0, resolve: 0, tree: 0, blobs: 0 };
    const files: Record<string, FakeFile> = {};
    for (let skill = 0; skill < 10; skill++) {
      const root = `catalog/skill-${skill}`;
      files[`${root}/SKILL.md`] = {
        content: `---\nname: skill-${skill}\ndescription: Skill\n---\nbody\n`,
      };
      for (let file = 0; file < 4; file++) {
        files[`${root}/references/${file}.md`] = { content: "x".repeat(220 * 1024) };
      }
    }

    await expect(
      fetchBulkSkillImport(
        fakeProvider(files, { calls, sizelessTree: true }),
        source({ subdirectory: "catalog" })
      )
    ).rejects.toThrow(new RegExp(`${MAX_BULK_SKILL_IMPORT_BYTES}-byte aggregate limit`));
    expect(calls.blobs).toBeGreaterThan(0);
  });
});

describe("fetchSelectedBulkSkillImport", () => {
  function collection(count: number): Record<string, FakeFile> {
    const files: Record<string, FakeFile> = {};
    for (let index = 0; index < count; index++) {
      const root = `catalog/skill-${index}`;
      files[`${root}/SKILL.md`] = {
        content: `---\nname: skill-${index}\ndescription: Skill ${index}\n---\nbody\n`,
      };
      files[`${root}/references/guide.md`] = { content: `guide ${index}` };
    }
    return files;
  }

  it("refuses a moved ref before listing the tree or reading blobs", async () => {
    const calls = { access: 0, resolve: 0, tree: 0, blobs: 0 };
    const error = await fetchSelectedBulkSkillImport(
      fakeProvider(collection(MAX_BULK_SKILL_IMPORT_SKILLS + 1), { calls }),
      source({ subdirectory: "catalog" }),
      { expectedCommitSha: "f".repeat(40), subdirectories: ["catalog/skill-0"] }
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SkillImportError);
    expect((error as SkillImportError).status).toBe(409);
    expect((error as SkillImportError).message).toMatch(`source moved to commit ${COMMIT}`);
    expect(calls).toEqual({ access: 1, resolve: 1, tree: 0, blobs: 0 });
  });

  it("reads and maps only the selected roots, in selection order", async () => {
    const calls = { access: 0, resolve: 0, tree: 0, blobs: 0 };

    const result = await fetchSelectedBulkSkillImport(
      fakeProvider(collection(MAX_BULK_SKILL_IMPORT_SKILLS), { calls }),
      source({ subdirectory: "catalog" }),
      { expectedCommitSha: COMMIT, subdirectories: ["catalog/skill-42", "catalog/skill-7"] }
    );

    expect(result.skills.map((skill) => skill.name)).toEqual(["skill-42", "skill-7"]);
    expect(result).toMatchObject({ commitSha: COMMIT, totalFiles: 4 });
    expect(calls).toEqual({ access: 1, resolve: 1, tree: 1, blobs: 4 });
  });

  it("does not validate unselected skill content", async () => {
    const result = await fetchSelectedBulkSkillImport(
      fakeProvider(
        { ...collection(1), "catalog/broken/SKILL.md": { content: "no frontmatter" } },
        { otherEntries: ["catalog/broken/link"] }
      ),
      source({ subdirectory: "catalog" }),
      { expectedCommitSha: COMMIT, subdirectories: ["catalog/skill-0"] }
    );

    expect(result.skills.map((skill) => skill.name)).toEqual(["skill-0"]);
  });

  it("refuses a selected root the reviewed commit does not contain", async () => {
    const calls = { access: 0, resolve: 0, tree: 0, blobs: 0 };

    await expect(
      fetchSelectedBulkSkillImport(
        fakeProvider(collection(2), { calls }),
        source({ subdirectory: "catalog" }),
        { expectedCommitSha: COMMIT, subdirectories: ["catalog/skill-0", "elsewhere/skill"] }
      )
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("elsewhere/skill is no longer in the collection"),
    });
    expect(calls.blobs).toBe(0);
  });
});
