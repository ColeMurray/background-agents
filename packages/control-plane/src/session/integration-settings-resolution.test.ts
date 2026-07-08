import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionScopedSettings } from "./integration-settings-resolution";

const mockState = vi.hoisted(() => ({
  resolvedCalls: [] as Array<{ id: string; repo: string }>,
  globalCalls: [] as string[],
  resolved: {} as Record<
    string,
    { enabledRepos: string[] | null; settings: Record<string, unknown> }
  >,
  global: {} as Record<string, { defaults: Record<string, unknown> }>,
}));

vi.mock("../db/integration-settings", () => ({
  IntegrationSettingsStore: class {
    async getResolvedConfig(id: string, repo: string) {
      mockState.resolvedCalls.push({ id, repo });
      return mockState.resolved[id] ?? { enabledRepos: null, settings: {} };
    }
    async getGlobal(id: string) {
      mockState.globalCalls.push(id);
      return mockState.global[id] ?? null;
    }
  },
}));

const DB = {} as D1Database;

describe("resolveSessionScopedSettings", () => {
  beforeEach(() => {
    mockState.resolvedCalls = [];
    mockState.globalCalls = [];
    mockState.resolved = {};
    mockState.global = {};
  });

  it("resolves both settings from the primary (position 0) member", async () => {
    mockState.resolved["code-server"] = { enabledRepos: null, settings: { enabled: true } };
    mockState.resolved["sandbox"] = { enabledRepos: null, settings: { tunnelPorts: [8080] } };

    const result = await resolveSessionScopedSettings(DB, [
      { repoOwner: "acme", repoName: "web" },
      { repoOwner: "acme", repoName: "backend" },
    ]);

    expect(result).toEqual({
      codeServerEnabled: true,
      sandboxSettings: { tunnelPorts: [8080] },
    });
    // Every resolution targets the primary member; the secondary is never asked about.
    expect(mockState.resolvedCalls.map((c) => c.repo)).toEqual(["acme/web", "acme/web"]);
    expect(mockState.resolvedCalls.map((c) => c.id).sort()).toEqual(["code-server", "sandbox"]);
  });

  it("falls back to global sandbox defaults and disabled code-server for a repo-less session", async () => {
    mockState.global["sandbox"] = { defaults: { tunnelPorts: [3000] } };

    const result = await resolveSessionScopedSettings(DB, []);

    expect(result.codeServerEnabled).toBe(false);
    expect(result.sandboxSettings).toEqual({ tunnelPorts: [3000] });
    // No per-repo resolution happens without a primary member.
    expect(mockState.resolvedCalls).toEqual([]);
    expect(mockState.globalCalls).toContain("sandbox");
  });
});
