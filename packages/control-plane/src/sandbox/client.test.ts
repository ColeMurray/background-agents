import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildModalSandboxDashboardUrl,
  buildModalWorkspaceSlug,
  createModalClient,
} from "./client";

describe("buildModalWorkspaceSlug", () => {
  it("uses the raw workspace when the Modal environment has no web suffix", () => {
    expect(buildModalWorkspaceSlug("acme")).toBe("acme");
    expect(buildModalWorkspaceSlug("acme", "")).toBe("acme");
  });

  it("appends the Modal environment web suffix for endpoint URLs", () => {
    expect(buildModalWorkspaceSlug("acme", "prod-web")).toBe("acme-prod-web");
  });
});

describe("buildModalSandboxDashboardUrl", () => {
  it("builds a Modal dashboard URL for a sandbox object", () => {
    expect(
      buildModalSandboxDashboardUrl({
        workspace: "acme",
        providerObjectId: "sb-123",
      })
    ).toBe(
      "https://modal.com/apps/acme/main/deployed/open-inspect?activeTab=sandboxes&sandboxId=sb-123"
    );
  });

  it("supports an explicit Modal environment", () => {
    expect(
      buildModalSandboxDashboardUrl({
        workspace: "acme",
        environment: "production",
        providerObjectId: "sb-123",
      })
    ).toBe(
      "https://modal.com/apps/acme/production/deployed/open-inspect?activeTab=sandboxes&sandboxId=sb-123"
    );
  });

  it("encodes URL components", () => {
    expect(
      buildModalSandboxDashboardUrl({
        workspace: "acme team",
        environment: "prod/main",
        providerObjectId: "sb 123/456?x=1",
      })
    ).toBe(
      "https://modal.com/apps/acme%20team/prod%2Fmain/deployed/open-inspect?activeTab=sandboxes&sandboxId=sb%20123%2F456%3Fx%3D1"
    );
  });

  it("returns null when required inputs are missing", () => {
    expect(
      buildModalSandboxDashboardUrl({
        workspace: undefined,
        providerObjectId: "sb-123",
      })
    ).toBeNull();
    expect(
      buildModalSandboxDashboardUrl({
        workspace: "acme",
        providerObjectId: null,
      })
    ).toBeNull();
  });
});

describe("ModalClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the Modal environment web suffix in endpoint URLs", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { status: "ok", service: "modal" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const client = createModalClient("secret", "acme", "prod-web");
    await client.health();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://acme-prod-web--open-inspect-api-health.modal.run"
    );
  });

  it("routes the restore session_config through buildSessionConfig (carries mcp_servers)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { sandbox_id: "sb-1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const client = createModalClient("secret", "acme", "prod-web");
    await client.restoreSandbox({
      snapshotImageId: "img-1",
      sessionId: "session-123",
      sandboxId: "sandbox-456",
      sandboxAuthToken: "auth-token",
      controlPlaneUrl: "https://control-plane.test",
      repoOwner: "testowner",
      repoName: "testrepo",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-5",
      mcpServers: [{ id: "mcp-1", name: "Tool", type: "local", enabled: true }],
    });

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.session_config).toEqual({
      session_id: "session-123",
      repo_owner: "testowner",
      repo_name: "testrepo",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-5",
      mcp_servers: [{ id: "mcp-1", name: "Tool", type: "local", enabled: true }],
    });
  });

  it("sends multi-repo members as flat snake_case create fields", async () => {
    // Modal's create handler builds its SessionConfig from the request by
    // field name, so the wire keys must match SessionConfig exactly.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { sandbox_id: "sb-1", status: "spawning", created_at: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const client = createModalClient("secret", "acme", "prod-web");
    await client.createSandbox({
      sessionId: "session-123",
      sandboxId: "sandbox-456",
      repoOwner: "testowner",
      repoName: "testrepo",
      controlPlaneUrl: "https://control-plane.test",
      sandboxAuthToken: "auth-token",
      repositories: [
        { repoOwner: "testowner", repoName: "testrepo", branch: "main" },
        { repoOwner: "testowner", repoName: "backend", branch: "develop" },
      ],
      workingBranchName: "open-inspect/session-123",
    });

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.repositories).toEqual([
      { repo_owner: "testowner", repo_name: "testrepo", branch: "main" },
      { repo_owner: "testowner", repo_name: "backend", branch: "develop" },
    ]);
    expect(body.working_branch_name).toBe("open-inspect/session-123");
  });

  it("sends null multi-repo create fields for single-repo sessions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { sandbox_id: "sb-1", status: "spawning", created_at: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const client = createModalClient("secret", "acme", "prod-web");
    await client.createSandbox({
      sessionId: "session-123",
      repoOwner: "testowner",
      repoName: "testrepo",
      controlPlaneUrl: "https://control-plane.test",
      sandboxAuthToken: "auth-token",
    });

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.repositories).toBeNull();
    expect(body.working_branch_name).toBeNull();
  });

  it("routes multi-repo members through the restore session_config", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { sandbox_id: "sb-1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const client = createModalClient("secret", "acme", "prod-web");
    await client.restoreSandbox({
      snapshotImageId: "img-1",
      sessionId: "session-123",
      sandboxId: "sandbox-456",
      sandboxAuthToken: "auth-token",
      controlPlaneUrl: "https://control-plane.test",
      repoOwner: "testowner",
      repoName: "testrepo",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-5",
      repositories: [
        { repoOwner: "testowner", repoName: "testrepo", branch: "main" },
        { repoOwner: "testowner", repoName: "backend", branch: "develop" },
      ],
      workingBranchName: "open-inspect/session-123",
    });

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.session_config.repositories).toEqual([
      { repo_owner: "testowner", repo_name: "testrepo", branch: "main" },
      { repo_owner: "testowner", repo_name: "backend", branch: "develop" },
    ]);
    expect(body.session_config.working_branch_name).toBe("open-inspect/session-123");
  });

  it("threads the build timeout into the repo image build request body", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ success: true, data: { build_id: "img-1", status: "building" } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

    const client = createModalClient("secret", "acme", "prod-web");
    await client.buildRepoImage({
      repoOwner: "acme",
      repoName: "repo",
      defaultBranch: "main",
      buildId: "img-1",
      callbackUrl: "https://cp.test/repo-images/build-complete",
      buildTimeoutSeconds: 2400,
    });

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.build_timeout_seconds).toBe(2400);
  });

  it("sends a null build timeout when unset so Modal applies its default", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ success: true, data: { build_id: "img-1", status: "building" } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

    const client = createModalClient("secret", "acme", "prod-web");
    await client.buildRepoImage({
      repoOwner: "acme",
      repoName: "repo",
      defaultBranch: "main",
      buildId: "img-1",
      callbackUrl: "https://cp.test/repo-images/build-complete",
    });

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.build_timeout_seconds).toBeNull();
  });
});
