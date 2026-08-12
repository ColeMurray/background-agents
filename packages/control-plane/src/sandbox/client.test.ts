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
        modalEnvironment: "production",
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
        modalEnvironment: "prod/main",
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
        { repoOwner: "testowner", repoName: "testrepo", baseBranch: "main" },
        { repoOwner: "testowner", repoName: "backend", baseBranch: "develop" },
      ],
    });

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.repositories).toEqual([
      { repo_owner: "testowner", repo_name: "testrepo", branch: "main" },
      { repo_owner: "testowner", repo_name: "backend", branch: "develop" },
    ]);
  });

  it("sends a null repositories create field for single-repo sessions", async () => {
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
  });

  it("parses optional create response fields without rejecting valid Modal data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            sandbox_id: "sb-1",
            modal_object_id: "mo-1",
            status: "spawning",
            created_at: 1,
            code_server_url: "https://code.test",
            code_server_password: "pw",
            vnc_url: "https://vnc.test",
            vnc_password: "vnc-pw",
            ttyd_url: "https://ttyd.test",
            tunnel_urls: { "3000": "https://3000.test" },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const client = createModalClient("secret", "acme", "prod-web");
    await expect(
      client.createSandbox({
        sessionId: "session-123",
        repoOwner: "testowner",
        repoName: "testrepo",
        controlPlaneUrl: "https://control-plane.test",
        sandboxAuthToken: "auth-token",
      })
    ).resolves.toEqual({
      sandboxId: "sb-1",
      modalObjectId: "mo-1",
      status: "spawning",
      createdAt: 1,
      codeServerUrl: "https://code.test",
      codeServerPassword: "pw",
      vncUrl: "https://vnc.test",
      vncPassword: "vnc-pw",
      ttydUrl: "https://ttyd.test",
      tunnelUrls: { "3000": "https://3000.test" },
    });
  });

  it("parses nullable create response fields from Modal-infra", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            sandbox_id: "sb-1",
            modal_object_id: null,
            status: "spawning",
            created_at: 1,
            code_server_url: null,
            code_server_password: null,
            vnc_url: null,
            vnc_password: null,
            ttyd_url: null,
            tunnel_urls: null,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const client = createModalClient("secret", "acme", "prod-web");
    const result = await client.createSandbox({
      sessionId: "session-123",
      repoOwner: "testowner",
      repoName: "testrepo",
      controlPlaneUrl: "https://control-plane.test",
      sandboxAuthToken: "auth-token",
    });

    expect(result).toEqual({
      sandboxId: "sb-1",
      modalObjectId: undefined,
      status: "spawning",
      createdAt: 1,
      codeServerUrl: undefined,
      codeServerPassword: undefined,
      vncUrl: undefined,
      vncPassword: undefined,
      ttydUrl: undefined,
      tunnelUrls: undefined,
    });
  });

  it("rejects malformed create responses instead of trusting the payload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { sandbox_id: "sb-1", status: "spawning", created_at: "1" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const client = createModalClient("secret", "acme", "prod-web");
    await expect(
      client.createSandbox({
        sessionId: "session-123",
        repoOwner: "testowner",
        repoName: "testrepo",
        controlPlaneUrl: "https://control-plane.test",
        sandboxAuthToken: "auth-token",
      })
    ).rejects.toThrow("Modal API error: Invalid response");
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
        { repoOwner: "testowner", repoName: "testrepo", baseBranch: "main" },
        { repoOwner: "testowner", repoName: "backend", baseBranch: "develop" },
      ],
    });

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.session_config.repositories).toEqual([
      { repo_owner: "testowner", repo_name: "testrepo", branch: "main" },
      { repo_owner: "testowner", repo_name: "backend", branch: "develop" },
    ]);
  });

  it("rejects malformed restore responses instead of trusting the payload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { sandbox_id: 123 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const client = createModalClient("secret", "acme", "prod-web");
    await expect(
      client.restoreSandbox({
        snapshotImageId: "img-1",
        sessionId: "session-123",
        sandboxId: "sandbox-456",
        sandboxAuthToken: "auth-token",
        controlPlaneUrl: "https://control-plane.test",
        repoOwner: "testowner",
        repoName: "testrepo",
        provider: "anthropic",
        model: "anthropic/claude-sonnet-4-5",
      })
    ).rejects.toThrow("Modal API error: Invalid response");
  });

  it("parses nullable restore response fields from Modal-infra", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            sandbox_id: "sb-1",
            modal_object_id: null,
            status: "warming",
            code_server_url: null,
            code_server_password: null,
            vnc_url: null,
            vnc_password: null,
            ttyd_url: null,
            tunnel_urls: null,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const client = createModalClient("secret", "acme", "prod-web");
    await expect(
      client.restoreSandbox({
        snapshotImageId: "img-1",
        sessionId: "session-123",
        sandboxId: "sandbox-456",
        sandboxAuthToken: "auth-token",
        controlPlaneUrl: "https://control-plane.test",
        repoOwner: "testowner",
        repoName: "testrepo",
        provider: "anthropic",
        model: "anthropic/claude-sonnet-4-5",
      })
    ).resolves.toEqual({
      success: true,
      sandboxId: "sb-1",
      modalObjectId: undefined,
      codeServerUrl: undefined,
      codeServerPassword: undefined,
      vncUrl: undefined,
      vncPassword: undefined,
      ttydUrl: undefined,
      tunnelUrls: undefined,
    });
  });

  it("sends VNC enablement on create and restore", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
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
      repoOwner: null,
      repoName: null,
      controlPlaneUrl: "https://control-plane.test",
      sandboxAuthToken: "auth-token",
      vncEnabled: true,
    });
    await client.restoreSandbox({
      snapshotImageId: "img-1",
      sessionId: "session-123",
      sandboxId: "sandbox-456",
      sandboxAuthToken: "auth-token",
      controlPlaneUrl: "https://control-plane.test",
      repoOwner: null,
      repoName: null,
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-5",
      vncEnabled: true,
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).vnc_enabled).toBe(true);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).vnc_enabled).toBe(true);
  });

  it("parses valid snapshot responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { image_id: "img-1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const client = createModalClient("secret", "acme", "prod-web");
    await expect(
      client.snapshotSandbox({
        providerObjectId: "mo-1",
        sessionId: "session-123",
        reason: "manual",
      })
    ).resolves.toEqual({ success: true, imageId: "img-1" });
  });

  it("snapshots image builds through the identity-bound build endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { image_id: "img-build-1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const client = createModalClient("secret", "acme", "prod-web");
    await expect(
      client.snapshotBuildSandbox({
        buildId: "imgb-1",
        providerSessionId: "mo-build-1",
      })
    ).resolves.toEqual({ success: true, imageId: "img-build-1" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://acme-prod-web--open-inspect-api-snapshot-build-sandbox.modal.run",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          build_id: "imgb-1",
          provider_session_id: "mo-build-1",
        }),
      })
    );
  });

  it("rejects malformed snapshot responses instead of trusting the payload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { image_id: 123 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const client = createModalClient("secret", "acme", "prod-web");
    await expect(
      client.snapshotSandbox({
        providerObjectId: "mo-1",
        sessionId: "session-123",
        reason: "manual",
      })
    ).rejects.toThrow("Modal API error: Invalid response");
  });

  it("creates a dormant image-build sandbox before callback credentials are available", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ success: true, data: { provider_session_id: "modal-session-1" } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

    const client = createModalClient("secret", "acme", "prod-web");
    const result = await client.createImageBuildSandbox({
      scopeKind: "repo",
      scopeId: "acme/repo",
      buildId: "imgb-1",
      repositories: [{ repoOwner: "acme", repoName: "repo", baseBranch: "develop" }],
      cloneToken: "clone-token",
      cloneHost: "gitlab.com",
      cloneUsername: "oauth2",
      callbackUrl: "https://worker.test/image-builds/build-complete",
      failureCallbackUrl: "https://worker.test/image-builds/build-failed",
      buildExecutionTimeoutSeconds: 1800,
      providerSessionTimeoutSeconds: 2400,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://acme-prod-web--open-inspect-api-create-build-sandbox.modal.run",
      expect.any(Object)
    );
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      clone_token: "clone-token",
      clone_host: "gitlab.com",
      clone_username: "oauth2",
      callback_url: "https://worker.test/image-builds/build-complete",
      failure_callback_url: "https://worker.test/image-builds/build-failed",
    });
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body).toEqual({
      scope_kind: "repo",
      scope_id: "acme/repo",
      build_id: "imgb-1",
      repositories: [{ repo_owner: "acme", repo_name: "repo", branch: "develop" }],
      clone_token: "clone-token",
      clone_host: "gitlab.com",
      clone_username: "oauth2",
      callback_url: "https://worker.test/image-builds/build-complete",
      failure_callback_url: "https://worker.test/image-builds/build-failed",
      build_execution_timeout_seconds: 1800,
      provider_session_timeout_seconds: 2400,
    });
    expect(result).toEqual({ providerSessionId: "modal-session-1" });
  });

  it("starts the exact bound image-build sandbox with callback credentials", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { started: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const client = createModalClient("secret", "acme", "prod-web");
    await client.startImageBuildSandbox({
      buildId: "imgb-1",
      providerSessionId: "modal-session-1",
      callbackToken: "cb-token-1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://acme-prod-web--open-inspect-api-start-build-sandbox.modal.run",
      expect.any(Object)
    );
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body).toEqual({
      build_id: "imgb-1",
      provider_session_id: "modal-session-1",
      callback_token: "cb-token-1",
    });
  });

  it("rejects malformed image build sandbox responses instead of trusting the payload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { provider_session_id: 123 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const client = createModalClient("secret", "acme", "prod-web");
    await expect(
      client.createImageBuildSandbox({
        scopeKind: "repo",
        scopeId: "acme/repo",
        buildId: "imgb-1",
        repositories: [{ repoOwner: "acme", repoName: "repo", baseBranch: "develop" }],
        cloneToken: "clone-token",
        cloneHost: "github.com",
        cloneUsername: "x-access-token",
        callbackUrl: "https://cp.test/image-builds/build-complete",
        failureCallbackUrl: "https://cp.test/image-builds/build-failed",
        buildExecutionTimeoutSeconds: 1800,
        providerSessionTimeoutSeconds: 2400,
      })
    ).rejects.toThrow("Modal API error: Invalid response");
  });

  it("rejects malformed image build operation responses instead of trusting the payload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: "yes" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const client = createModalClient("secret", "acme", "prod-web");
    await expect(
      client.startImageBuildSandbox({
        buildId: "imgb-1",
        providerSessionId: "modal-session-1",
        callbackToken: "cb-token-1",
      })
    ).rejects.toThrow("Modal API error: Invalid response");
  });

  it("parses valid provider image delete responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { provider_image_id: "img-1", deleted: true },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const client = createModalClient("secret", "acme", "prod-web");
    await expect(client.deleteProviderImage({ providerImageId: "img-1" })).resolves.toEqual({
      providerImageId: "img-1",
      deleted: true,
    });
  });

  it("rejects malformed provider image delete responses instead of trusting the payload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { provider_image_id: "img-1", deleted: "yes" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const client = createModalClient("secret", "acme", "prod-web");
    await expect(client.deleteProviderImage({ providerImageId: "img-1" })).rejects.toThrow(
      "Modal API error: Invalid response"
    );
  });
});
