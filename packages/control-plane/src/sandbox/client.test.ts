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
      ttydUrl: undefined,
      tunnelUrls: undefined,
    });
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

  it("posts image builds to the single api-build-image endpoint with scope fields", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ success: true, data: { build_id: "imgb-1", status: "building" } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

    const client = createModalClient("secret", "acme", "prod-web");
    const result = await client.buildImage({
      scopeKind: "repo",
      scopeId: "acme/repo",
      buildId: "imgb-1",
      callbackUrl: "https://cp.test/image-builds/build-complete",
      failureCallbackUrl: "https://cp.test/image-builds/build-failed",
      repositories: [{ repoOwner: "acme", repoName: "repo", baseBranch: "develop" }],
      buildTimeoutSeconds: 2400,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://acme-prod-web--open-inspect-api-build-image.modal.run",
      expect.any(Object)
    );
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body).toEqual({
      scope_kind: "repo",
      scope_id: "acme/repo",
      build_id: "imgb-1",
      callback_url: "https://cp.test/image-builds/build-complete",
      failure_callback_url: "https://cp.test/image-builds/build-failed",
      repositories: [{ repo_owner: "acme", repo_name: "repo", branch: "develop" }],
      build_timeout_seconds: 2400,
    });
    expect(result).toEqual({ buildId: "imgb-1", status: "building" });
  });

  it("sends a null build timeout when unset so Modal applies its default", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ success: true, data: { build_id: "imgb-1", status: "building" } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

    const client = createModalClient("secret", "acme", "prod-web");
    await client.buildImage({
      scopeKind: "environment",
      scopeId: "env_1",
      buildId: "imgb-1",
      callbackUrl: "https://cp.test/image-builds/build-complete",
      failureCallbackUrl: "https://cp.test/image-builds/build-failed",
      repositories: [{ repoOwner: "acme", repoName: "web", baseBranch: "main" }],
    });

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.build_timeout_seconds).toBeNull();
  });
});
