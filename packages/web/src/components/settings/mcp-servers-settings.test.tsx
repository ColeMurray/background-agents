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
  fetchMcpServerCredentials: vi.fn(),
  allowedPermissions: null as Set<string> | null,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-repos", () => ({
  useRepos: () => ({ repos: [], loading: false }),
}));
vi.mock("@/hooks/use-mcp-servers", () => ({
  useMcpServers: () => ({ servers, loading: false, mutate: mocks.mutate }),
  createMcpServer: vi.fn(),
  fetchMcpServerCredentials: mocks.fetchMcpServerCredentials,
  updateMcpServer: mocks.updateMcpServer,
  deleteMcpServer: vi.fn(),
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
  {
    id: "server-c",
    revision: 2,
    name: "Server C",
    type: "remote",
    url: "https://c.example.com",
    hasEnv: false,
    hasHeaders: true,
    repoScopes: null,
    enabled: true,
  },
];

const savedHeaders = {
  id: "server-c",
  revision: 2,
  type: "remote" as const,
  headers: { Authorization: "Bearer old", "X-Api-Key": "key-1" },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.allowedPermissions = null;
});

describe("McpServersSettings", () => {
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

  it("shows saved header names and values when editing", async () => {
    mocks.fetchMcpServerCredentials.mockResolvedValue(savedHeaders);
    const user = userEvent.setup();
    render(<McpServersSettings />);

    await user.click(screen.getByRole("button", { name: /Server C/ }));

    expect(mocks.fetchMcpServerCredentials).toHaveBeenCalledWith("server-c");
    expect(await screen.findByDisplayValue("Authorization")).toBeInTheDocument();
    expect(screen.getByDisplayValue("X-Api-Key")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Bearer old")).toBeInTheDocument();
    expect(screen.getByDisplayValue("key-1")).toBeInTheDocument();
  });

  it("saves the headers shown in the form, keeping untouched ones", async () => {
    mocks.fetchMcpServerCredentials.mockResolvedValue(savedHeaders);
    mocks.updateMcpServer.mockResolvedValue({ ...servers[2], revision: 3 });
    const user = userEvent.setup();
    render(<McpServersSettings />);

    await user.click(screen.getByRole("button", { name: /Server C/ }));
    const authValue = await screen.findByDisplayValue("Bearer old");
    await user.clear(authValue);
    await user.type(authValue, "Bearer new");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mocks.updateMcpServer).toHaveBeenCalled());
    expect(mocks.updateMcpServer).toHaveBeenCalledWith(
      "server-c",
      expect.objectContaining({
        headers: { Authorization: "Bearer new", "X-Api-Key": "key-1" },
        revision: 2,
      })
    );
  });

  it("deletes a saved header when its row is removed", async () => {
    mocks.fetchMcpServerCredentials.mockResolvedValue(savedHeaders);
    mocks.updateMcpServer.mockResolvedValue({ ...servers[2], revision: 3 });
    const user = userEvent.setup();
    render(<McpServersSettings />);

    await user.click(screen.getByRole("button", { name: /Server C/ }));
    await screen.findByDisplayValue("X-Api-Key");
    await user.click(screen.getAllByRole("button", { name: "Remove" })[1]);
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mocks.updateMcpServer).toHaveBeenCalled());
    expect(mocks.updateMcpServer).toHaveBeenCalledWith(
      "server-c",
      expect.objectContaining({ headers: { Authorization: "Bearer old" } })
    );
  });

  it("keeps saved headers when they fail to load and no new values are entered", async () => {
    mocks.fetchMcpServerCredentials.mockRejectedValue(new Error("boom"));
    mocks.updateMcpServer.mockResolvedValue({ ...servers[2], revision: 3 });
    const user = userEvent.setup();
    render(<McpServersSettings />);

    await user.click(screen.getByRole("button", { name: /Server C/ }));
    expect(await screen.findByText(/Credentials are configured/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mocks.updateMcpServer).toHaveBeenCalled());
    expect(mocks.updateMcpServer.mock.calls[0][1]).not.toHaveProperty("headers");
  });
});
