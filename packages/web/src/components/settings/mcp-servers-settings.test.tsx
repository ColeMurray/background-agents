// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { McpServerMetadata } from "@open-inspect/shared/types/integrations";
import { McpServersSettings } from "./mcp-servers-settings";

expect.extend(matchers);

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  updateMcpServer: vi.fn(),
  createMcpConnection: vi.fn(),
  deleteMcpConnection: vi.fn(),
  authorizeMcpConnection: vi.fn(),
  mutateConnections: vi.fn(),
  connectionFeatureEnabled: false,
  connections: [] as Array<{
    id: string;
    serverId: string;
    serverName: string;
    endpointHost: string;
    status: string;
    tools: unknown[];
  }>,
  allowedPermissions: null as Set<string> | null,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-repos", () => ({
  useRepos: () => ({ repos: [], loading: false }),
}));
vi.mock("@/hooks/use-mcp-servers", () => ({
  useMcpServers: () => ({ servers, loading: false, mutate: mocks.mutate }),
  createMcpServer: vi.fn(),
  updateMcpServer: mocks.updateMcpServer,
  deleteMcpServer: vi.fn(),
}));
vi.mock("@/hooks/use-mcp-connections", () => ({
  useMcpConnections: () => ({
    enabled: mocks.connectionFeatureEnabled,
    connections: mocks.connections,
    loading: false,
    mutate: mocks.mutateConnections,
  }),
  createMcpConnection: mocks.createMcpConnection,
  deleteMcpConnection: mocks.deleteMcpConnection,
  authorizeMcpConnection: mocks.authorizeMcpConnection,
}));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    hasPermission: (permission: string) =>
      mocks.allowedPermissions === null || mocks.allowedPermissions.has(permission),
  }),
}));

const servers: McpServerMetadata[] = [
  {
    id: "server-a",
    revision: 3,
    name: "Server A",
    type: "remote",
    url: "https://a.example.com",
    hasEnv: false,
    hasHeaders: false,
    repoScopes: null,
    enabled: true,
  },
  {
    id: "server-b",
    revision: 7,
    name: "Server B",
    type: "remote",
    url: "https://b.example.com",
    hasEnv: false,
    hasHeaders: false,
    repoScopes: null,
    enabled: true,
  },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.allowedPermissions = null;
  mocks.connectionFeatureEnabled = false;
  mocks.connections = [];
});

describe("McpServersSettings", () => {
  it("shows the dormant connection foundation without implying OAuth is available", () => {
    render(<McpServersSettings />);

    expect(screen.getByText("Personal MCP connections")).toBeInTheDocument();
    expect(screen.getByText(/foundation is dormant/i)).toBeInTheDocument();
    expect(screen.queryByText(/oauth/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add a connection/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /authorize/i })).not.toBeInTheDocument();
  });

  it("stages only catalog-selected personal connections when the foundation is enabled", async () => {
    mocks.connectionFeatureEnabled = true;
    mocks.createMcpConnection.mockResolvedValue({ id: "connection-a" });
    const user = userEvent.setup();
    render(<McpServersSettings />);

    await user.click(screen.getByRole("button", { name: "Add a connection for Server A" }));

    expect(mocks.createMcpConnection).toHaveBeenCalledWith({ serverId: "server-a" });
    await waitFor(() => expect(mocks.mutateConnections).toHaveBeenCalled());
  });

  it("tells the owner when a connection is waiting for their approval", async () => {
    mocks.connectionFeatureEnabled = true;
    mocks.connections = [
      {
        id: "connection-a",
        serverId: "server-a",
        serverName: "Server A",
        endpointHost: "a.example.com",
        status: "oauth_authorizing",
        tools: [],
      },
    ];
    const user = userEvent.setup();
    render(<McpServersSettings />);

    expect(screen.getByText(/waiting for your approval/i)).toBeInTheDocument();

    mocks.authorizeMcpConnection.mockResolvedValue({ state: "authenticating" });
    await user.click(screen.getByRole("button", { name: "Authorize Server A" }));

    expect(mocks.authorizeMcpConnection).toHaveBeenCalledWith("connection-a", {
      reconnect: false,
    });
  });

  it("offers a reconnect that replaces a credential the provider refused", async () => {
    mocks.connectionFeatureEnabled = true;
    mocks.connections = [
      {
        id: "connection-a",
        serverId: "server-a",
        serverName: "Server A",
        endpointHost: "a.example.com",
        status: "failed",
        tools: [],
      },
    ];
    mocks.authorizeMcpConnection.mockResolvedValue({ state: "authenticating" });
    const user = userEvent.setup();
    render(<McpServersSettings />);

    expect(screen.getByText(/could not connect/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Authorize Server A" }));

    expect(mocks.authorizeMcpConnection).toHaveBeenCalledWith("connection-a", {
      reconnect: true,
    });
  });

  it("shows an authorized connection without an approval action", () => {
    mocks.connectionFeatureEnabled = true;
    mocks.connections = [
      {
        id: "connection-a",
        serverId: "server-a",
        serverName: "Server A",
        endpointHost: "a.example.com",
        status: "oauth_ready",
        tools: [],
      },
    ];
    render(<McpServersSettings />);

    expect(screen.getByText(/authorized/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Authorize Server A" })).not.toBeInTheDocument();
  });

  it("shows servers but no mutation entry points with read-only permission", () => {
    mocks.allowedPermissions = new Set(["mcp_servers.read"]);

    render(<McpServersSettings />);

    expect(screen.getByText("Server A")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Server" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Server A/ })).toBeDisabled();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("does not close a newer draft when an older save completes", async () => {
    let resolveSave!: (server: McpServerMetadata) => void;
    mocks.updateMcpServer.mockReturnValue(
      new Promise<McpServerMetadata>((resolve) => {
        resolveSave = resolve;
      })
    );
    const user = userEvent.setup();
    render(<McpServersSettings />);

    await user.click(screen.getByRole("button", { name: /Server A/ }));
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(mocks.updateMcpServer).toHaveBeenCalledWith(
      "server-a",
      expect.objectContaining({ revision: 3 })
    );

    await user.click(screen.getByRole("button", { name: /Server B/ }));
    expect(screen.getByDisplayValue("https://b.example.com")).toBeInTheDocument();

    resolveSave({ ...servers[0], revision: 4 });

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalled());
    expect(screen.getByDisplayValue("https://b.example.com")).toBeInTheDocument();
  });

  it("does not reinterpret entered credentials when the server type changes", async () => {
    mocks.updateMcpServer.mockResolvedValue({ ...servers[0], type: "local", revision: 4 });
    const user = userEvent.setup();
    render(<McpServersSettings />);

    await user.click(screen.getByRole("button", { name: /Server A/ }));
    await user.type(screen.getByPlaceholderText("Header-Name"), "Authorization");
    await user.type(screen.getByPlaceholderText("value"), "secret");
    await user.click(screen.getByRole("button", { name: "Local" }));
    await user.type(screen.getByPlaceholderText("npx -y @playwright/mcp"), "npx tool");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mocks.updateMcpServer).toHaveBeenCalled());
    expect(mocks.updateMcpServer).toHaveBeenCalledWith("server-a", {
      name: "Server A",
      enabled: true,
      repoScopes: null,
      type: "local",
      command: ["npx", "tool"],
      revision: 3,
    });
  });
});
