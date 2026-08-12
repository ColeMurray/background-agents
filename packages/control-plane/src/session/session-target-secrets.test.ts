import { describe, expect, it, vi } from "vitest";
import {
  buildSessionTargetSecretSources,
  resolveSessionOAuthSecretScope,
} from "./session-target-secrets";
import type { SessionRepositoryEntry } from "./repository-target";
import type { SessionRow } from "./types";

function member(
  repoOwner: string,
  repoName: string,
  position: number,
  isPrimary: boolean
): SessionRepositoryEntry {
  return { repoOwner, repoName, position, isPrimary, baseBranch: "main", row: null };
}

/** Repo-launched sessions never load environment secrets; a stub keeps that explicit. */
const noEnvironmentSecrets = async (): Promise<Record<string, string>> => ({});

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-1",
    session_name: "session-1",
    title: null,
    repo_owner: null,
    repo_name: null,
    repo_id: null,
    base_branch: null,
    branch_name: null,
    base_sha: null,
    current_sha: null,
    opencode_session_id: null,
    model: "xai/grok-build-0.1",
    reasoning_effort: null,
    status: "active",
    parent_session_id: null,
    spawn_source: "user",
    spawn_depth: 0,
    code_server_enabled: 0,
    vnc_enabled: 0,
    total_cost: 0,
    sandbox_settings: null,
    environment_id: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe("resolveSessionOAuthSecretScope", () => {
  it.each([
    { repo_owner: "acme", repo_name: null },
    { repo_owner: null, repo_name: "web" },
    { repo_owner: "acme", repo_name: null, environment_id: "env_1" },
    { repo_owner: "", repo_name: "web" },
    { repo_owner: "acme", repo_name: "" },
    { repo_owner: "", repo_name: "" },
    { repo_owner: " ", repo_name: "web" },
  ])("rejects incomplete or empty repository context", async (overrides) => {
    const ensureRepoId = vi.fn();

    await expect(resolveSessionOAuthSecretScope(session(overrides), ensureRepoId)).rejects.toThrow(
      "Session has incomplete repository context"
    );
    expect(ensureRepoId).not.toHaveBeenCalled();
  });

  it("resolves a complete historical repository target", async () => {
    const ensureRepoId = vi.fn().mockResolvedValue(123);
    const target = session({ repo_owner: "acme", repo_name: "web", repo_id: null });

    await expect(resolveSessionOAuthSecretScope(target, ensureRepoId)).resolves.toEqual({
      kind: "repo",
      repoId: 123,
      repoOwner: "acme",
      repoName: "web",
    });
    expect(ensureRepoId).toHaveBeenCalledWith(target);
  });

  it("resolves an environment target without repository context", async () => {
    const ensureRepoId = vi.fn();

    await expect(
      resolveSessionOAuthSecretScope(session({ environment_id: "env_1" }), ensureRepoId)
    ).resolves.toEqual({ kind: "environment", environmentId: "env_1" });
    expect(ensureRepoId).not.toHaveBeenCalled();
  });

  it("gives an environment target precedence over complete repository context", async () => {
    const ensureRepoId = vi.fn();

    await expect(
      resolveSessionOAuthSecretScope(
        session({ environment_id: "env_1", repo_owner: "group/subgroup", repo_name: "web" }),
        ensureRepoId
      )
    ).resolves.toEqual({ kind: "environment", environmentId: "env_1" });
    expect(ensureRepoId).not.toHaveBeenCalled();
  });

  it("returns no scope only when repository context is fully absent", async () => {
    const ensureRepoId = vi.fn();

    await expect(resolveSessionOAuthSecretScope(session(), ensureRepoId)).resolves.toBeNull();
    expect(ensureRepoId).not.toHaveBeenCalled();
  });
});

describe("buildSessionTargetSecretSources", () => {
  it("folds members lowest-precedence-first with the primary (position 0) last", async () => {
    const secretsByRepo: Record<string, Record<string, string>> = {
      "acme/web": { A: "web" },
      "acme/backend": { B: "backend" },
    };

    const sources = await buildSessionTargetSecretSources({
      environmentId: null,
      globalSecrets: { G: "g" },
      members: [member("acme", "web", 0, true), member("acme", "backend", 1, false)],
      loadMemberSecrets: async (m) => secretsByRepo[`${m.repoOwner}/${m.repoName}`] ?? {},
      loadEnvironmentSecrets: noEnvironmentSecrets,
    });

    // Primary (acme/web) is appended last so mergeSecretSources lets it win.
    expect(sources.map((s) => s.label)).toEqual(["global", "acme/backend", "acme/web"]);
  });

  it("folds global + environment for an environment-launched session — member repos never inherit", async () => {
    const loadMemberSecrets = vi.fn();

    const sources = await buildSessionTargetSecretSources({
      environmentId: "env_flagship",
      globalSecrets: { G: "g" },
      members: [member("acme", "web", 0, true)],
      loadMemberSecrets,
      loadEnvironmentSecrets: async (id): Promise<Record<string, string>> =>
        id === "env_flagship" ? { E: "env" } : {},
    });

    expect(sources.map((s) => s.label)).toEqual(["global", "environment"]);
    // Member repo secrets are never sourced for an environment session.
    expect(loadMemberSecrets).not.toHaveBeenCalled();
  });

  it("returns only global for an environment session with no environment secrets", async () => {
    const sources = await buildSessionTargetSecretSources({
      environmentId: "env_empty",
      globalSecrets: { G: "g" },
      members: [member("acme", "web", 0, true)],
      loadMemberSecrets: vi.fn(),
      loadEnvironmentSecrets: noEnvironmentSecrets,
    });

    expect(sources.map((s) => s.label)).toEqual(["global"]);
  });

  it("omits members that contribute no secrets", async () => {
    const sources = await buildSessionTargetSecretSources({
      environmentId: null,
      globalSecrets: {},
      members: [member("acme", "web", 0, true), member("acme", "empty", 1, false)],
      loadMemberSecrets: async (m): Promise<Record<string, string>> =>
        m.repoName === "empty" ? {} : { A: "1" },
      loadEnvironmentSecrets: noEnvironmentSecrets,
    });

    expect(sources.map((s) => s.label)).toEqual(["global", "acme/web"]);
  });

  it("returns only global when there are no members", async () => {
    const sources = await buildSessionTargetSecretSources({
      environmentId: null,
      globalSecrets: { G: "g" },
      members: [],
      loadMemberSecrets: async () => ({}),
      loadEnvironmentSecrets: noEnvironmentSecrets,
    });

    expect(sources).toEqual([{ label: "global", secrets: { G: "g" } }]);
  });
});
