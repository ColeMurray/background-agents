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
    });

    // Primary (acme/web) is appended last so mergeSecretSources lets it win.
    expect(sources.map((s) => s.label)).toEqual(["global", "acme/backend", "acme/web"]);
  });

  it("returns only global for an environment-launched session — member repos never inherit", async () => {
    const loadMemberSecrets = vi.fn();

    const sources = await buildLaunchUnitSecretSources({
      environmentId: 42,
      globalSecrets: { G: "g" },
      members: [member("acme", "web", 0, true)],
      loadMemberSecrets,
    });

    expect(sources.map((s) => s.label)).toEqual(["global"]);
    expect(loadMemberSecrets).not.toHaveBeenCalled();
  });

  it("omits members that contribute no secrets", async () => {
    const sources = await buildLaunchUnitSecretSources({
      environmentId: null,
      globalSecrets: {},
      members: [member("acme", "web", 0, true), member("acme", "empty", 1, false)],
      loadMemberSecrets: async (m): Promise<Record<string, string>> =>
        m.repoName === "empty" ? {} : { A: "1" },
    });

    expect(sources.map((s) => s.label)).toEqual(["global", "acme/web"]);
  });

  it("returns only global when there are no members", async () => {
    const sources = await buildLaunchUnitSecretSources({
      environmentId: null,
      globalSecrets: { G: "g" },
      members: [],
      loadMemberSecrets: async () => ({}),
    });

    expect(sources).toEqual([{ label: "global", secrets: { G: "g" } }]);
  });
});
