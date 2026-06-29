import { describe, expect, it, vi } from "vitest";
import type { AutomationRow } from "../db/automation-store";
import type { Env } from "../types";
import type { SourceControlProvider } from "../source-control";
import { resolveAutomationSessionLaunches } from "./target-resolution";

const automation: AutomationRow = {
  id: "auto-1",
  name: "Daily sync",
  repo_owner: "ACME",
  repo_name: "Web-App",
  base_branch: "release",
  repo_id: 111,
  instructions: "Run tests",
  trigger_type: "schedule",
  schedule_cron: "0 9 * * *",
  schedule_tz: "UTC",
  model: "anthropic/claude-sonnet-4-6",
  reasoning_effort: null,
  enabled: 1,
  next_run_at: 1000,
  consecutive_failures: 0,
  created_by: "user-1",
  user_id: null,
  created_at: 1000,
  updated_at: 1000,
  deleted_at: null,
  event_type: null,
  trigger_config: null,
  trigger_auth_data: null,
};

function createProvider(
  result: Awaited<ReturnType<SourceControlProvider["checkRepositoryAccess"]>>
): SourceControlProvider {
  return {
    checkRepositoryAccess: vi.fn().mockResolvedValue(result),
  } as unknown as SourceControlProvider;
}

describe("automation target resolution", () => {
  it("validates repo access and returns session repo fields", async () => {
    const provider = createProvider({
      repoId: 98765,
      repoOwner: "acme",
      repoName: "web-app",
      defaultBranch: "main",
    });

    await expect(
      resolveAutomationSessionLaunches({} as Env, automation, provider)
    ).resolves.toEqual([
      {
        repoOwner: "acme",
        repoName: "web-app",
        repoId: 98765,
        baseBranch: "release",
      },
    ]);

    expect(provider.checkRepositoryAccess).toHaveBeenCalledWith({
      owner: "ACME",
      name: "Web-App",
    });
  });

  it("falls back to the repository default branch when no fixed branch is configured", async () => {
    const provider = createProvider({
      repoId: 98765,
      repoOwner: "acme",
      repoName: "web-app",
      defaultBranch: "develop",
    });

    const result = await resolveAutomationSessionLaunches(
      {} as Env,
      { ...automation, base_branch: "" },
      provider
    );

    expect(result[0]).toMatchObject({ baseBranch: "develop" });
  });

  it("resolves repo-less launches without checking repository access", async () => {
    const provider = createProvider({
      repoId: 98765,
      repoOwner: "acme",
      repoName: "web-app",
      defaultBranch: "main",
    });

    await expect(
      resolveAutomationSessionLaunches(
        {} as Env,
        {
          ...automation,
          repo_owner: null,
          repo_name: null,
          repo_id: null,
          base_branch: null,
        },
        provider
      )
    ).resolves.toEqual([{ repoOwner: null, repoName: null, repoId: null, baseBranch: null }]);

    expect(provider.checkRepositoryAccess).not.toHaveBeenCalled();
  });

  it("fails when the configured repository is not accessible", async () => {
    const provider = createProvider(null);

    await expect(resolveAutomationSessionLaunches({} as Env, automation, provider)).rejects.toThrow(
      "Repository is not accessible for the configured SCM provider"
    );
  });

  it("rejects partial repository fields", async () => {
    await expect(
      resolveAutomationSessionLaunches(
        {} as Env,
        { ...automation, repo_name: null },
        createProvider(null)
      )
    ).rejects.toThrow(
      "Automation repository target must include repo_owner and repo_name together"
    );
  });
});
