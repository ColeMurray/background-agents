// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ browserApiFetch: vi.fn() }));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: mocks.browserApiFetch }));

import {
  bulkImportSkills,
  previewBulkSkillImport,
  useSkillResolutionPreview,
} from "./use-managed-skills";

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
  );
}

function previewResponse(name: string) {
  return Response.json({
    skills: [
      {
        skillId: `skill-${name}`,
        revisionId: `revision-${name}`,
        name,
        description: `${name} description`,
        revisionNumber: 1,
        revisionSha256: "abc",
        totalBytes: 10,
        assignmentSources: [],
      },
    ],
    totalBytes: 10,
    ignoredProfileSkillIds: [],
  });
}

describe("useSkillResolutionPreview", () => {
  beforeEach(() => vi.resetAllMocks());

  it("never exposes preview data from the previous target key", async () => {
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    mocks.browserApiFetch
      .mockReturnValueOnce(new Promise<Response>((resolve) => (resolveFirst = resolve)))
      .mockReturnValueOnce(new Promise<Response>((resolve) => (resolveSecond = resolve)));

    const { result, rerender } = renderHook(
      ({ repoName }) =>
        useSkillResolutionPreview({ repoOwner: "open-inspect", repoName }, { mode: "all" }),
      { initialProps: { repoName: "first" }, wrapper }
    );
    await waitFor(() => expect(mocks.browserApiFetch).toHaveBeenCalledTimes(1));

    await act(async () => resolveFirst(previewResponse("first-skill")));
    await waitFor(() => expect(result.current.preview?.skills[0].name).toBe("first-skill"));

    rerender({ repoName: "second" });
    expect(result.current.preview).toBeNull();
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(mocks.browserApiFetch).toHaveBeenCalledTimes(2));

    await act(async () => resolveSecond(previewResponse("second-skill")));
    await waitFor(() => expect(result.current.preview?.skills[0].name).toBe("second-skill"));

    const requestBodies = mocks.browserApiFetch.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body))
    );
    expect(requestBodies).toEqual([
      { repoOwner: "open-inspect", repoName: "first", selection: { mode: "all" } },
      { repoOwner: "open-inspect", repoName: "second", selection: { mode: "all" } },
    ]);
  });
});

describe("bulk skill import requests", () => {
  beforeEach(() => vi.resetAllMocks());

  it("validates and returns a bulk preview", async () => {
    const source = {
      provider: "github" as const,
      repoOwner: "acme",
      repoName: "skills",
      requestedRef: null,
      resolvedRef: "main",
      commitSha: "a".repeat(40),
      subdirectory: "catalog/deploy",
      sourceSha256: "b".repeat(64),
    };
    mocks.browserApiFetch.mockResolvedValue(
      Response.json({
        skills: [
          {
            name: "deploy",
            source,
            description: "Deploy service",
            body: "Deploy it",
            license: null,
            compatibility: null,
            metadata: {},
            revisionSha256: "c".repeat(64),
            totalBytes: 9,
            files: [
              {
                path: "SKILL.md",
                content: "Deploy it",
                sizeBytes: 9,
                executable: false,
              },
            ],
            warnings: [],
            nameAvailable: true,
          },
        ],
        commitSha: "a".repeat(40),
        totalFiles: 1,
        totalBytes: 9,
      })
    );
    const input = {
      source: {
        repository: { repoOwner: "acme", repoName: "skills" },
        ref: null,
        subdirectory: "catalog",
      },
    };

    await expect(previewBulkSkillImport(input)).resolves.toMatchObject({ totalFiles: 1 });
    expect(mocks.browserApiFetch).toHaveBeenCalledWith("/api/skills/import/bulk/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  });

  it("rejects malformed bulk import responses", async () => {
    mocks.browserApiFetch.mockResolvedValue(Response.json({ skills: [{ id: "incomplete" }] }));

    await expect(
      bulkImportSkills({
        assignments: [],
        source: {
          repository: { repoOwner: "acme", repoName: "skills" },
          ref: null,
          subdirectory: null,
        },
        expectedCommitSha: "a".repeat(40),
        skills: [
          {
            subdirectory: "deploy",
            name: "deploy",
            expectedSourceSha256: "b".repeat(64),
            expectedRevisionSha256: "c".repeat(64),
          },
        ],
      })
    ).rejects.toThrow();
  });

  it("accepts compact bulk import identities", async () => {
    const response = {
      skills: [{ id: "skill-1", name: "deploy", currentRevisionId: "revision-1" }],
    };
    mocks.browserApiFetch.mockResolvedValue(Response.json(response));

    await expect(
      bulkImportSkills({
        assignments: [],
        source: { repository: { repoOwner: "acme", repoName: "skills" }, subdirectory: null },
        expectedCommitSha: "a".repeat(40),
        skills: [
          {
            subdirectory: "deploy",
            name: "deploy",
            expectedSourceSha256: "b".repeat(64),
            expectedRevisionSha256: "c".repeat(64),
          },
        ],
      })
    ).resolves.toEqual(response.skills);
  });
});
