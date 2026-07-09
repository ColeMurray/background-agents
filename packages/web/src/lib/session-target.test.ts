import { describe, expect, it } from "vitest";
import {
  type SessionTarget,
  MULTIPLE_REPOSITORIES_OPTION_VALUE,
  NO_REPOSITORY_OPTION_VALUE,
  buildSessionTargetRequestFields,
  environmentOptionValue,
  getTargetConfigKey,
  getTargetSelectValue,
  isSessionTargetLaunchable,
  parseTargetSelectValue,
} from "./session-target";

describe("buildSessionTargetRequestFields", () => {
  it("emits exactly one target mode per kind (createSessionRequestSchema exclusivity)", () => {
    const branch = "develop";

    const none = buildSessionTargetRequestFields({ kind: "none" }, branch);
    expect(none).toEqual({ repoOwner: null, repoName: null });

    const repo = buildSessionTargetRequestFields(
      { kind: "repo", repoFullName: "acme/backend" },
      branch
    );
    expect(repo).toEqual({ repoOwner: "acme", repoName: "backend", branch: "develop" });
    expect(repo).not.toHaveProperty("environmentId");
    expect(repo).not.toHaveProperty("repositories");

    const environment = buildSessionTargetRequestFields(
      { kind: "environment", environmentId: "env-1" },
      branch
    );
    expect(environment).toEqual({ environmentId: "env-1" });

    const repos = buildSessionTargetRequestFields(
      { kind: "repos", repoFullNames: ["acme/backend", "acme/frontend"] },
      branch
    );
    expect(repos).toEqual({
      repositories: [
        { repoOwner: "acme", repoName: "backend" },
        { repoOwner: "acme", repoName: "frontend" },
      ],
    });
    expect(repos).not.toHaveProperty("branch");
  });

  it("omits branch for a repo target when no branch is selected", () => {
    const fields = buildSessionTargetRequestFields(
      { kind: "repo", repoFullName: "acme/backend" },
      ""
    );
    expect(fields).toEqual({ repoOwner: "acme", repoName: "backend", branch: undefined });
    expect(JSON.parse(JSON.stringify(fields))).not.toHaveProperty("branch");
  });
});

describe("select-value round trip", () => {
  it("round-trips each target kind through its option value", () => {
    const targets: SessionTarget[] = [
      { kind: "none" },
      { kind: "repo", repoFullName: "acme/backend" },
      { kind: "environment", environmentId: "env_abc123" },
    ];
    for (const target of targets) {
      expect(parseTargetSelectValue(getTargetSelectValue(target), null)).toEqual(target);
    }
  });

  it("maps the sentinels to their option values", () => {
    expect(getTargetSelectValue({ kind: "none" })).toBe(NO_REPOSITORY_OPTION_VALUE);
    expect(getTargetSelectValue({ kind: "repos", repoFullNames: ["a/b"] })).toBe(
      MULTIPLE_REPOSITORIES_OPTION_VALUE
    );
    expect(getTargetSelectValue({ kind: "environment", environmentId: "env-1" })).toBe(
      environmentOptionValue("env-1")
    );
  });

  it("seeds the multi-repository mode from the previously selected repo", () => {
    expect(
      parseTargetSelectValue(MULTIPLE_REPOSITORIES_OPTION_VALUE, {
        kind: "repo",
        repoFullName: "Acme/Backend",
      })
    ).toEqual({ kind: "repos", repoFullNames: ["acme/backend"] });

    expect(parseTargetSelectValue(MULTIPLE_REPOSITORIES_OPTION_VALUE, { kind: "none" })).toEqual({
      kind: "repos",
      repoFullNames: [],
    });

    const existing: SessionTarget = { kind: "repos", repoFullNames: ["a/b", "a/c"] };
    expect(parseTargetSelectValue(MULTIPLE_REPOSITORIES_OPTION_VALUE, existing)).toBe(existing);
  });
});

describe("getTargetConfigKey", () => {
  it("distinguishes ad-hoc lists so edits invalidate a warmed session", () => {
    const one = getTargetConfigKey({ kind: "repos", repoFullNames: ["a/b"] });
    const two = getTargetConfigKey({ kind: "repos", repoFullNames: ["a/b", "a/c"] });
    expect(one).not.toBe(two);
  });
});

describe("isSessionTargetLaunchable", () => {
  it("requires at least one repository in the ad-hoc mode", () => {
    expect(isSessionTargetLaunchable(null)).toBe(false);
    expect(isSessionTargetLaunchable({ kind: "repos", repoFullNames: [] })).toBe(false);
    expect(isSessionTargetLaunchable({ kind: "repos", repoFullNames: ["a/b"] })).toBe(true);
    expect(isSessionTargetLaunchable({ kind: "none" })).toBe(true);
    expect(isSessionTargetLaunchable({ kind: "environment", environmentId: "env-1" })).toBe(true);
  });
});
