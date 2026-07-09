import { describe, expect, it } from "vitest";
import type { Environment, RepoConfig } from "./types";
import {
  branchPreferenceRepo,
  buildSessionTargetRequestFields,
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

describe("target values", () => {
  it("round-trips repository and environment values", () => {
    expect(parseTargetValue(targetValue(repoTarget))).toEqual({
      kind: "repository",
      repoId: "acme/web",
    });
    expect(parseTargetValue(targetValue(environmentTarget))).toEqual({
      kind: "environment",
      environmentId: "env_abc123",
    });
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
  });
});

describe("targetId", () => {
  it("returns the repo id or environment id", () => {
    expect(targetId(repoTarget)).toBe("acme/web");
    expect(targetId(environmentTarget)).toBe("env_abc123");
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
});

describe("branchPreferenceRepo", () => {
  it("returns the repo for repository targets and null for environments", () => {
    expect(branchPreferenceRepo(repoTarget)).toBe(REPO);
    expect(branchPreferenceRepo(environmentTarget)).toBeNull();
  });
});
