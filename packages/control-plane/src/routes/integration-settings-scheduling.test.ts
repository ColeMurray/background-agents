import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestContext } from "./shared";
import type { Env } from "../types";

const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  list: vi.fn(),
  repositories: vi.fn(),
  listEnabledScopes: vi.fn(),
}));

vi.mock("../image-builds/save-hooks", () => ({
  scheduleImageBuildOnSave: mocks.schedule,
}));
vi.mock("../image-builds/scope", () => ({
  listEnabledScopes: mocks.listEnabledScopes,
}));
vi.mock("../db/environments", () => ({
  EnvironmentStore: class {
    list = mocks.list;
    getRepositoriesForEnvironmentIds = mocks.repositories;
  },
}));

import { scheduleSandboxSettingsRebuilds } from "./integration-settings";

describe("sandbox settings rebuild scheduling", () => {
  const env = { SANDBOX_PROVIDER: "daytona" } as Env;
  const ctx = {
    db: {} as D1Database,
    request_id: "request-1",
    trace_id: "trace-1",
    executionCtx: {},
  } as unknown as RequestContext;

  beforeEach(() => vi.clearAllMocks());

  it("fans a repo settings change out to its repo and enabled inheriting environments", async () => {
    mocks.list.mockResolvedValue({
      environments: [
        { id: "env-enabled", prebuild_enabled: 1 },
        { id: "env-disabled", prebuild_enabled: 0 },
        { id: "env-other", prebuild_enabled: 1 },
      ],
    });
    mocks.repositories.mockResolvedValue(
      new Map([
        ["env-enabled", [{ repo_owner: "acme", repo_name: "web" }]],
        ["env-disabled", [{ repo_owner: "acme", repo_name: "web" }]],
        ["env-other", [{ repo_owner: "other", repo_name: "web" }]],
      ])
    );

    await scheduleSandboxSettingsRebuilds(env, ctx, {
      repoOwner: "acme",
      repoName: "web",
    });

    expect(mocks.schedule.mock.calls.map(([, scope]) => scope)).toEqual([
      { kind: "repo", id: "acme/web" },
      { kind: "environment", id: "env-enabled" },
    ]);
  });

  it.each(["save", "delete"])(
    "keeps a successful %s response path best-effort when scheduling queries fail",
    async () => {
      mocks.list.mockRejectedValue(new Error("D1 unavailable"));

      await expect(
        scheduleSandboxSettingsRebuilds(env, ctx, { repoOwner: "acme", repoName: "web" })
      ).resolves.toBeUndefined();
      expect(mocks.schedule).not.toHaveBeenCalled();
    }
  );
});
