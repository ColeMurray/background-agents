import { describe, expect, it } from "vitest";
import {
  type AutomationSessionTarget,
  buildRepositoriesPayload,
  collapseToSingleTarget,
  hydrateTargets,
  initialBaseBranch,
  initialSelectionMode,
  nextBaseBranch,
  toggleTarget,
} from "./automation-target-selection";

const repoTarget = (repoFullName: string): AutomationSessionTarget => ({
  kind: "repo",
  repoFullName,
});
const environmentTarget = (environmentId: string): AutomationSessionTarget => ({
  kind: "environment",
  environmentId,
});

const repos = [
  { fullName: "open-inspect/background-agents", defaultBranch: "main" },
  { fullName: "Acme/Web-App", defaultBranch: "trunk" },
];

describe("hydrateTargets", () => {
  it("lowercases repository keys and appends environments after repositories", () => {
    expect(
      hydrateTargets(
        [{ repoOwner: "Acme", repoName: "Web-App", baseBranch: "release" }],
        ["env_1", "env_2"]
      )
    ).toEqual([repoTarget("acme/web-app"), environmentTarget("env_1"), environmentTarget("env_2")]);
  });

  it("hydrates the empty selection as no targets", () => {
    expect(hydrateTargets([], [])).toEqual([]);
  });
});

describe("initialSelectionMode", () => {
  it("opens in single-select for at most one target", () => {
    expect(initialSelectionMode([], [])).toBe("single");
    expect(initialSelectionMode([{ repoOwner: "acme", repoName: "web-app" }], [])).toBe("single");
    expect(initialSelectionMode([], ["env_1"])).toBe("single");
  });

  it("opens in multi-select for combined repository + environment counts above one", () => {
    expect(initialSelectionMode([{ repoOwner: "acme", repoName: "web-app" }], ["env_1"])).toBe(
      "multiple"
    );
    expect(
      initialSelectionMode(
        [
          { repoOwner: "acme", repoName: "web-app" },
          { repoOwner: "acme", repoName: "api" },
        ],
        []
      )
    ).toBe("multiple");
  });
});

describe("initialBaseBranch", () => {
  it("hydrates the stored branch of a sole stored repository", () => {
    expect(
      initialBaseBranch([{ repoOwner: "acme", repoName: "web-app", baseBranch: "release" }])
    ).toBe("release");
  });

  it("hydrates empty when the sole repository has no stored branch", () => {
    expect(initialBaseBranch([{ repoOwner: "acme", repoName: "web-app" }])).toBe("");
  });

  it("hydrates empty for anything other than exactly one repository", () => {
    expect(initialBaseBranch([])).toBe("");
    expect(
      initialBaseBranch([
        { repoOwner: "acme", repoName: "web-app", baseBranch: "release" },
        { repoOwner: "acme", repoName: "api", baseBranch: "develop" },
      ])
    ).toBe("");
  });
});

describe("collapseToSingleTarget", () => {
  it("keeps the first repository even when an environment was selected first", () => {
    expect(
      collapseToSingleTarget([
        environmentTarget("env_1"),
        repoTarget("acme/web-app"),
        repoTarget("acme/api"),
      ])
    ).toEqual([repoTarget("acme/web-app")]);
  });

  it("keeps the first environment when only environments are selected", () => {
    expect(
      collapseToSingleTarget([environmentTarget("env_1"), environmentTarget("env_2")])
    ).toEqual([environmentTarget("env_1")]);
  });
});

describe("toggleTarget", () => {
  it("appends an unselected target below the cap", () => {
    expect(toggleTarget([repoTarget("acme/web-app")], environmentTarget("env_1"), 3)).toEqual([
      repoTarget("acme/web-app"),
      environmentTarget("env_1"),
    ]);
  });

  it("removes a selected target, even at the cap", () => {
    expect(
      toggleTarget(
        [repoTarget("acme/web-app"), environmentTarget("env_1")],
        repoTarget("acme/web-app"),
        2
      )
    ).toEqual([environmentTarget("env_1")]);
  });

  it("returns null when adding would exceed the cap", () => {
    expect(
      toggleTarget(
        [repoTarget("acme/web-app"), environmentTarget("env_1")],
        repoTarget("acme/api"),
        2
      )
    ).toBeNull();
  });
});

describe("nextBaseBranch", () => {
  it("pins the default branch when membership changes to exactly one repository", () => {
    expect(nextBaseBranch([], [repoTarget("open-inspect/background-agents")], repos)).toBe("main");
  });

  it("matches the repos list case-insensitively (the selection stores lowercase keys)", () => {
    expect(nextBaseBranch([], [repoTarget("acme/web-app")], repos)).toBe("trunk");
  });

  it("falls back to empty for a repository missing from the repos list", () => {
    expect(nextBaseBranch([], [repoTarget("acme/unknown")], repos)).toBe("");
  });

  it("clears the branch when membership changes away from exactly one repository", () => {
    const soleRepo = [repoTarget("open-inspect/background-agents")];
    expect(nextBaseBranch(soleRepo, [...soleRepo, repoTarget("acme/web-app")], repos)).toBe("");
    expect(nextBaseBranch(soleRepo, [], repos)).toBe("");
  });

  it("re-pins the default branch when the identical selection is re-committed", () => {
    // A single-select re-click of the current repository resets a branch pick.
    const soleRepo = [repoTarget("open-inspect/background-agents")];
    expect(nextBaseBranch(soleRepo, [repoTarget("open-inspect/background-agents")], repos)).toBe(
      "main"
    );
  });

  it("leaves the branch alone when only environments change around the repository", () => {
    const soleRepo = [repoTarget("open-inspect/background-agents")];
    expect(nextBaseBranch(soleRepo, [...soleRepo, environmentTarget("env_1")], repos)).toBeNull();
    // Collapsing a mixed selection back to its repository keeps the pick too:
    // repository membership never changed while the environment came and went.
    expect(nextBaseBranch([...soleRepo, environmentTarget("env_1")], soleRepo, repos)).toBeNull();
  });
});

describe("buildRepositoriesPayload", () => {
  it("includes the trimmed branch for a single-repository selection", () => {
    expect(buildRepositoriesPayload(["acme/web-app"], true, " release ", [])).toEqual([
      { repoOwner: "acme", repoName: "web-app", baseBranch: "release" },
    ]);
  });

  it("omits the branch for a single-repository selection with no pick", () => {
    expect(buildRepositoriesPayload(["acme/web-app"], true, " ", [])).toEqual([
      { repoOwner: "acme", repoName: "web-app" },
    ]);
  });

  it("keeps each already-stored branch and leaves new entries branchless otherwise", () => {
    expect(
      buildRepositoriesPayload(["acme/web-app", "acme/api"], false, "ignored", [
        { repoOwner: "Acme", repoName: "Web-App", baseBranch: "release" },
      ])
    ).toEqual([
      { repoOwner: "acme", repoName: "web-app", baseBranch: "release" },
      { repoOwner: "acme", repoName: "api" },
    ]);
  });
});
