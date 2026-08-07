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
      buildDurationSeconds: 12.5,
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

  it("keeps the frozen hash canonicalization stable across refactors", async () => {
    // Golden value computed from the pre-seconds-refactor canonical document
    // ({... buildDurationMs: 12500}). The completion hash is a persisted
    // idempotency contract: a deploy-straddling callback retry must hash
    // identically before and after a refactor. If this fails, the hash
    // schema changed — that requires an explicit version migration, not a
    // fixture update.
    const job = await createImageBuildFinalizationJob({
      outcome: "success",
      completion: {
        buildId: "build-1",
        providerSessionId: "session-1",
        repositoryShas: [
          { repoOwner: "Acme", repoName: "Web", baseSha: "abc123" },
          { repoOwner: "Acme", repoName: "Api", baseSha: "def456" },
        ],
        runtimeVersion: "v53-runtime",
        buildDurationSeconds: 12.5,
      },
    });

    expect(job.completionHash).toBe(
      "a38995471a349e98e513c04a4a8806b3275e2dcbbff53523ab50aee0d0644df9"
    );
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
      buildDurationSeconds: 12.5,
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
