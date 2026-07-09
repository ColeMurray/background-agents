import { describe, expect, it, vi } from "vitest";
import { buildLaunchUnitSecretSources } from "./launch-unit-secrets";
import type { SessionRepositoryEntry } from "./repository-target";

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

describe("buildLaunchUnitSecretSources", () => {
  it("folds members lowest-precedence-first with the primary (position 0) last", async () => {
    const secretsByRepo: Record<string, Record<string, string>> = {
      "acme/web": { A: "web" },
      "acme/backend": { B: "backend" },
    };

    const sources = await buildLaunchUnitSecretSources({
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

    const sources = await buildLaunchUnitSecretSources({
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
    const sources = await buildLaunchUnitSecretSources({
      environmentId: "env_empty",
      globalSecrets: { G: "g" },
      members: [member("acme", "web", 0, true)],
      loadMemberSecrets: vi.fn(),
      loadEnvironmentSecrets: noEnvironmentSecrets,
    });

    expect(sources.map((s) => s.label)).toEqual(["global"]);
  });

  it("omits members that contribute no secrets", async () => {
    const sources = await buildLaunchUnitSecretSources({
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
    const sources = await buildLaunchUnitSecretSources({
      environmentId: null,
      globalSecrets: { G: "g" },
      members: [],
      loadMemberSecrets: async () => ({}),
      loadEnvironmentSecrets: noEnvironmentSecrets,
    });

    expect(sources).toEqual([{ label: "global", secrets: { G: "g" } }]);
  });
});
