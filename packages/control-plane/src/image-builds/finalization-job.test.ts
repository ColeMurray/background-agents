import { describe, expect, it } from "vitest";
import {
  createImageBuildFinalizationJob,
  imageBuildFinalizationJobSchema,
} from "./finalization-job";

describe("image build finalization jobs", () => {
  it("creates a deterministic, credential-free success command", async () => {
    const completion = {
      buildId: "build-1",
      providerSessionId: "session-1",
      repositoryShas: [
        { repoOwner: "Acme", repoName: "Web", baseSha: "abc123" },
        { repoOwner: "Acme", repoName: "Api", baseSha: "def456" },
      ],
      runtimeVersion: "v53-runtime",
      buildDurationMs: 12_500,
    };

    const first = await createImageBuildFinalizationJob({ outcome: "success", completion });
    const second = await createImageBuildFinalizationJob({
      outcome: "success",
      completion: structuredClone(completion),
    });

    expect(first).toEqual(second);
    expect(first).toEqual({
      version: 1,
      buildId: "build-1",
      completionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(imageBuildFinalizationJobSchema.parse(first)).toEqual(first);
    expect(JSON.stringify(first)).not.toContain("session-1");
    expect(JSON.stringify(first)).not.toContain("abc123");
  });

  it("treats repository SHA order as irrelevant to completion identity", async () => {
    const completion = {
      buildId: "build-1",
      providerSessionId: "session-1",
      repositoryShas: [
        { repoOwner: "Acme", repoName: "Web", baseSha: "abc123" },
        { repoOwner: "Acme", repoName: "Api", baseSha: "def456" },
      ],
      runtimeVersion: "v53-runtime",
      buildDurationMs: 12_500,
    };

    const ordered = await createImageBuildFinalizationJob({ outcome: "success", completion });
    const reordered = await createImageBuildFinalizationJob({
      outcome: "success",
      completion: {
        ...completion,
        repositoryShas: [...completion.repositoryShas].reverse(),
      },
    });

    expect(reordered).toEqual(ordered);
  });
});
