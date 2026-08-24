import { describe, expect, it } from "vitest";
import {
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_REVISION_BYTES,
  skillImportSourceInputSchema,
} from "@open-inspect/shared/types/skills";
import type { GetRepositoryConfig, RepositoryReader, RepositoryTree } from "../source-control";
import { SourceControlProviderError } from "../source-control";
import { fetchSkillImport, SkillImportError } from "./git-import";

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
    checkRepositoryAccess: async (config: GetRepositoryConfig) =>
      overrides.accessible === false
        ? null
        : {
            repoId: 1,
            repoOwner: overrides.normalizedIdentity?.repoOwner ?? config.owner,
            repoName: overrides.normalizedIdentity?.repoName ?? config.name,
            defaultBranch: overrides.defaultBranch ?? "main",
          },
    resolveCommit: async () =>
      overrides.commit === null ? null : { sha: overrides.commit ?? COMMIT },
    listTree: async ({ path }) => {
      overrides.listedPaths?.push(path);
      return { entries, truncated: overrides.truncated ?? false };
    },
    readBlob: async ({ blobId, maxBytes }) => {
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
