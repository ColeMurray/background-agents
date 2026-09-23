import { describe, expect, it } from "vitest";
import type { Environment } from "@open-inspect/shared/types/environments";
import type { RepoConfig } from "@open-inspect/shared/types/repository-catalog";
import {
  branchPreferenceRepo,
  buildSessionTargetRequestFields,
  NO_REPOSITORY_TARGET_LABEL,
  NO_REPOSITORY_TARGET_VALUE,
  parseTargetValue,
  targetId,
  targetLabel,
  targetValue,
  type SlackSessionTarget,
} from "./targets";

const REPO: RepoConfig = {
  id: "acme/web",
  owner: "acme",
  name: "web",
  fullName: "acme/web",
  displayName: "web",
  description: "Web application",
  defaultBranch: "main",
  private: true,
};

const ENVIRONMENT: Environment = {
  id: "env_abc123",
  name: "full-stack",
  description: null,
  prebuildEnabled: false,
  createdAt: 1,
  updatedAt: 1,
  repositories: [{ repoOwner: "acme", repoName: "web", repoId: 1, baseBranch: "main" }],
};

const repoTarget: SlackSessionTarget = { kind: "repository", repo: REPO };
const environmentTarget: SlackSessionTarget = { kind: "environment", environment: ENVIRONMENT };
const noRepositoryTarget: SlackSessionTarget = { kind: "none" };

describe("target values", () => {
  it("round-trips repository, environment, and no-repository values", () => {
    expect(parseTargetValue(targetValue(repoTarget))).toEqual({
      kind: "repository",
      repoId: "acme/web",
    });
    expect(parseTargetValue(targetValue(environmentTarget))).toEqual({
      kind: "environment",
      environmentId: "env_abc123",
    });
    expect(targetValue(noRepositoryTarget)).toBe(NO_REPOSITORY_TARGET_VALUE);
    expect(parseTargetValue(targetValue(noRepositoryTarget))).toEqual({ kind: "none" });
  });

  it("treats bare values as repository ids (messages posted before environments)", () => {
    expect(parseTargetValue("acme/web")).toEqual({ kind: "repository", repoId: "acme/web" });
  });
});

describe("targetLabel", () => {
  it("returns the raw fullName or environment name — escaping is a render concern", () => {
    expect(targetLabel(repoTarget)).toBe("acme/web");
    const hostile: SlackSessionTarget = {
      kind: "environment",
      environment: { ...ENVIRONMENT, name: "<!channel> & co" },
    };
    // Stored records carry the raw name; mrkdwn render sites escape it.
    expect(targetLabel(hostile)).toBe("<!channel> & co");
    expect(targetLabel(noRepositoryTarget)).toBe(NO_REPOSITORY_TARGET_LABEL);
  });
});

describe("targetId", () => {
  it("returns the repo id or environment id", () => {
    expect(targetId(repoTarget)).toBe("acme/web");
    expect(targetId(environmentTarget)).toBe("env_abc123");
    expect(targetId(noRepositoryTarget)).toBe(NO_REPOSITORY_TARGET_VALUE);
  });
});

describe("buildSessionTargetRequestFields", () => {
  it("builds scalar repo fields with the branch", () => {
    expect(buildSessionTargetRequestFields(repoTarget, "dev")).toEqual({
      repoOwner: "acme",
      repoName: "web",
      branch: "dev",
    });
  });

  it("builds environmentId only — never a branch", () => {
    expect(buildSessionTargetRequestFields(environmentTarget, "dev")).toEqual({
      environmentId: "env_abc123",
    });
  });

  it("builds explicit null repository fields for no-repository sessions", () => {
    expect(buildSessionTargetRequestFields(noRepositoryTarget, "ignored")).toEqual({
      repoOwner: null,
      repoName: null,
    });
  });
});

describe("branchPreferenceRepo", () => {
  it("returns the repo only for repository targets", () => {
    expect(branchPreferenceRepo(repoTarget)).toBe(REPO);
    expect(branchPreferenceRepo(environmentTarget)).toBeNull();
    expect(branchPreferenceRepo(noRepositoryTarget)).toBeNull();
  });
});
