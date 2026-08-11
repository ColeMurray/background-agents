import { describe, expect, it, vi } from "vitest";
import { resolveSessionOAuthSecretScope } from "./oauth-secret-scope";
import type { SessionRow } from "./types";

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
  ])("rejects incomplete repository context", async (overrides) => {
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

  it("returns no scope only when repository context is fully absent", async () => {
    const ensureRepoId = vi.fn();

    await expect(resolveSessionOAuthSecretScope(session(), ensureRepoId)).resolves.toBeNull();
    expect(ensureRepoId).not.toHaveBeenCalled();
  });
});
