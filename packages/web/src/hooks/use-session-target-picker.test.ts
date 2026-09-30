// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "@open-inspect/shared/types/environments";
import type {
  ImageBuildRecordView,
  ImageBuildStatus,
} from "@open-inspect/shared/types/image-builds";
import { foldImageBuildStatusByScope, imageBuildScopeKey } from "@/lib/image-builds";
import type { Repo } from "@/hooks/use-repos";
import {
  MULTIPLE_REPOSITORIES_OPTION_VALUE,
  NO_REPOSITORY_OPTION_VALUE,
} from "@/lib/session-target";
import {
  describeEnvironment,
  describeRepository,
  useSessionTargetPicker,
} from "./use-session-target-picker";

const mocks = vi.hoisted(() => ({
  repos: vi.fn(),
  environments: vi.fn(),
}));
vi.mock("@/hooks/use-repos", () => ({ useRepos: mocks.repos }));
vi.mock("@/hooks/use-environments", () => ({ useEnvironments: mocks.environments }));
vi.mock("@/hooks/use-branches", () => ({ useBranches: () => ({ branches: [], loading: false }) }));
vi.mock("@/hooks/use-image-builds", () => ({ useImageBuilds: () => ({ data: undefined }) }));

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    name: "Stack",
    description: null,
    prebuildEnabled: true,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    repositories: [
      { repoOwner: "acme", repoName: "web", repoId: 1, baseBranch: "main" },
      { repoOwner: "acme", repoName: "api", repoId: 2, baseBranch: "main" },
    ],
    ...overrides,
  };
}

function statusMap(status: ImageBuildStatus): Map<string, ImageBuildStatus> {
  return new Map([[imageBuildScopeKey("environment", "env-1"), status]]);
}

describe("describeEnvironment", () => {
  it("shows the repository count without prebuild state when prebuilds are off", () => {
    expect(describeEnvironment(environment({ prebuildEnabled: false }), new Map())).toBe(
      "2 repositories"
    );
  });

  it("shows prebuilt for a ready scope", () => {
    expect(describeEnvironment(environment(), statusMap("ready"))).toBe(
      "2 repositories · prebuilt"
    );
  });

  it("shows prebuild building for a building scope", () => {
    expect(describeEnvironment(environment(), statusMap("building"))).toBe(
      "2 repositories · prebuild building"
    );
  });

  it("shows prebuild failed for a failed scope", () => {
    expect(describeEnvironment(environment(), statusMap("failed"))).toBe(
      "2 repositories · prebuild failed"
    );
  });

  it("falls back to prebuilds on when the scope has no build rows", () => {
    expect(describeEnvironment(environment(), new Map())).toBe("2 repositories · prebuilds on");
  });

  it("surfaces a failed-only aggregate through the fold", () => {
    const failedRow: ImageBuildRecordView = {
      id: "build-1",
      scopeKind: "environment",
      scopeId: "env-1",
      provider: "modal",
      status: "failed",
      repositoriesFingerprint: "fp-current",
      repositoryShas: [],
      runtimeVersion: "60",
      buildDurationSeconds: null,
      errorMessage: "boom",
      createdAt: 1700000000000,
    };

    const folded = foldImageBuildStatusByScope(
      [failedRow],
      [{ scopeKind: "environment", scopeId: "env-1", repositoriesFingerprint: "fp-current" }]
    );

    expect(describeEnvironment(environment(), folded)).toBe("2 repositories · prebuild failed");
  });
});

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 1,
    fullName: "acme/web",
    owner: "acme",
    name: "web",
    description: null,
    private: false,
    defaultBranch: "main",
    ...overrides,
  };
}

function repoStatusMap(status: ImageBuildStatus): Map<string, ImageBuildStatus> {
  return new Map([[imageBuildScopeKey("repo", "acme/web"), status]]);
}

describe("useSessionTargetPicker", () => {
  beforeEach(() => {
    mocks.repos.mockReset().mockReturnValue({ repos: [repo()], loading: false });
    mocks.environments
      .mockReset()
      .mockReturnValue({ environments: [environment()], loading: false });
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("passes teamId to the catalog hooks and prioritizes the team default over stored targets", () => {
    localStorage.setItem("open-inspect-last-selected-repo", "acme/web");
    const { result } = renderHook(() =>
      useSessionTargetPicker({ teamId: "team-1", defaultEnvironmentId: "env-1" })
    );
    expect(mocks.repos).toHaveBeenCalledWith(true, "team-1");
    expect(mocks.environments).toHaveBeenCalledWith("team-1");
    expect(result.current.buildRequestFields()).toEqual({ environmentId: "env-1" });
  });

  it("waits for the default environment catalog before choosing a target", () => {
    mocks.environments.mockReturnValue({ environments: [], loading: true });
    const { result, rerender } = renderHook(() =>
      useSessionTargetPicker({ defaultEnvironmentId: "env-1" })
    );
    expect(result.current.isLaunchable).toBe(false);
    mocks.environments.mockReturnValue({ environments: [environment()], loading: false });
    rerender();
    expect(result.current.buildRequestFields()).toEqual({ environmentId: "env-1" });
  });

  it("honors the next team's default when there has been no draft choice", () => {
    const { result, rerender } = renderHook((options) => useSessionTargetPicker(options), {
      initialProps: { teamId: "team-1", defaultEnvironmentId: "env-1" },
    });
    mocks.environments.mockReturnValue({
      environments: [environment({ id: "env-2" })],
      loading: false,
    });
    rerender({ teamId: "team-2", defaultEnvironmentId: "env-2" });
    expect(result.current.buildRequestFields()).toEqual({ environmentId: "env-2" });
  });

  it("uses a default that arrives after settings reconciliation without overriding a draft choice", () => {
    const initialProps: { teamId: string; defaultEnvironmentId: string | null } = {
      teamId: "team-1",
      defaultEnvironmentId: null,
    };
    const { result, rerender } = renderHook((options) => useSessionTargetPicker(options), {
      initialProps,
    });
    expect(result.current.sessionTarget).toEqual({ kind: "repo", repoFullName: "acme/web" });
    rerender({ teamId: "team-1", defaultEnvironmentId: "env-1" });
    expect(result.current.buildRequestFields()).toEqual({ environmentId: "env-1" });
    act(() => {
      result.current.pickerProps.onTargetSelectValueChange(NO_REPOSITORY_OPTION_VALUE);
    });
    rerender({ teamId: "team-2", defaultEnvironmentId: "env-1" });
    expect(result.current.buildRequestFields()).toEqual({ repoOwner: null, repoName: null });
  });

  it("keeps an explicit available target instead of replacing it with a team default", () => {
    const { result, rerender } = renderHook((options) => useSessionTargetPicker(options), {
      initialProps: { teamId: "team-1", defaultEnvironmentId: "env-1" },
    });
    act(() => {
      result.current.pickerProps.onTargetSelectValueChange("acme/web");
    });
    act(() => {
      result.current.pickerProps.setSelectedBranch("feature");
    });
    mocks.environments.mockReturnValue({
      environments: [environment({ id: "env-2" })],
      loading: false,
    });
    rerender({ teamId: "team-2", defaultEnvironmentId: "env-2" });
    expect(result.current.buildRequestFields()).toEqual({
      repoOwner: "acme",
      repoName: "web",
      branch: "feature",
    });
  });

  it("blocks stale targets while a new team catalog loads and reconciles when it settles", () => {
    const { result, rerender } = renderHook(({ teamId }) => useSessionTargetPicker({ teamId }), {
      initialProps: { teamId: "team-1" },
    });
    act(() => {
      result.current.pickerProps.onTargetSelectValueChange("acme/web");
    });
    mocks.repos.mockReturnValue({ repos: [], loading: true });
    rerender({ teamId: "team-2" });
    expect(result.current.buildRequestFields()).toBeNull();
    expect(result.current.isLaunchable).toBe(false);
    mocks.repos.mockReturnValue({
      repos: [repo({ fullName: "acme/api", name: "api", defaultBranch: "develop" })],
      loading: false,
    });
    rerender({ teamId: "team-2" });
    expect(result.current.buildRequestFields()).toEqual({
      repoOwner: "acme",
      repoName: "api",
      branch: "develop",
    });
  });

  it("removes unavailable repositories from an explicit ad-hoc selection on team change", () => {
    mocks.repos.mockReturnValue({
      repos: [repo(), repo({ fullName: "acme/api", name: "api" })],
      loading: false,
    });
    const { result, rerender } = renderHook(({ teamId }) => useSessionTargetPicker({ teamId }), {
      initialProps: { teamId: "team-1" },
    });
    act(() => {
      result.current.pickerProps.onMultiSelectionChange(["acme/web", "acme/api"]);
    });
    mocks.repos.mockReturnValue({ repos: [repo()], loading: false });
    rerender({ teamId: "team-2" });
    expect(result.current.buildRequestFields()).toEqual({
      repositories: [{ repoOwner: "acme", repoName: "web" }],
    });
  });

  it("preserves normalized multi-repository selections when the catalog uses mixed case", () => {
    mocks.repos.mockReturnValue({
      repos: [repo({ fullName: "Acme/Web", owner: "Acme", name: "Web" })],
      loading: false,
    });
    const { result, rerender } = renderHook(({ teamId }) => useSessionTargetPicker({ teamId }), {
      initialProps: { teamId: "team-1" },
    });
    act(() => {
      result.current.pickerProps.onTargetSelectValueChange(MULTIPLE_REPOSITORIES_OPTION_VALUE);
    });
    expect(result.current.buildRequestFields()).toEqual({
      repositories: [{ repoOwner: "acme", repoName: "web" }],
    });
    rerender({ teamId: "team-2" });
    expect(result.current.buildRequestFields()).toEqual({
      repositories: [{ repoOwner: "acme", repoName: "web" }],
    });
  });
});

describe("describeRepository", () => {
  const enabled = new Set(["acme/web"]);

  it("shows only the base description when prebuilds are off for the repo", () => {
    expect(describeRepository(repo(), new Map(), new Set())).toBe("acme");
  });

  it("marks private repos without a prebuild when prebuilds are off", () => {
    expect(describeRepository(repo({ private: true }), new Map(), new Set())).toBe(
      "acme • private"
    );
  });

  it("shows prebuilt for a ready scope", () => {
    expect(describeRepository(repo(), repoStatusMap("ready"), enabled)).toBe("acme · prebuilt");
  });

  it("shows prebuild building for a building scope", () => {
    expect(describeRepository(repo(), repoStatusMap("building"), enabled)).toBe(
      "acme · prebuild building"
    );
  });

  it("shows prebuild failed for a failed scope", () => {
    expect(describeRepository(repo(), repoStatusMap("failed"), enabled)).toBe(
      "acme · prebuild failed"
    );
  });

  it("falls back to prebuilds on when enabled with no build rows", () => {
    expect(describeRepository(repo(), new Map(), enabled)).toBe("acme · prebuilds on");
  });

  it("falls back to prebuilds on for a superseded scope", () => {
    expect(describeRepository(repo(), repoStatusMap("superseded"), enabled)).toBe(
      "acme · prebuilds on"
    );
  });

  it("looks up the fold map with a lowercased fullName", () => {
    const mixedCase = repo({ fullName: "Acme/Web", owner: "Acme", name: "Web" });
    const enabledMixed = new Set(["acme/web"]);
    expect(describeRepository(mixedCase, repoStatusMap("ready"), enabledMixed)).toBe(
      "Acme · prebuilt"
    );
  });
});
