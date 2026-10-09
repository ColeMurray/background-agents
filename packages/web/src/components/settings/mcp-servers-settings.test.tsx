// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { McpServerMetadata } from "@open-inspect/shared/types/integrations";
import { McpServersSettings } from "./mcp-servers-settings";

expect.extend(matchers);

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  createMcpServer: vi.fn(),
  updateMcpServer: vi.fn(),
  discoverMcpTools: vi.fn(),
  allowedPermissions: null as Set<string> | null,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-repos", () => ({
  useRepos: () => ({ repos: [], loading: false }),
}));
vi.mock("@/hooks/use-mcp-servers", () => ({
  useMcpServers: () => ({ servers, loading: false, mutate: mocks.mutate }),
  createMcpServer: mocks.createMcpServer,
  updateMcpServer: mocks.updateMcpServer,
  deleteMcpServer: vi.fn(),
  discoverMcpTools: mocks.discoverMcpTools,
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
    toolAllowlist: ["search", "retired_tool"],
    enabled: true,
  },
  {
    id: "server-c",
    revision: 1,
    name: "Server C",
    type: "local",
    command: ["npx", "server-c"],
    hasEnv: false,
    hasHeaders: false,
    repoScopes: null,
    enabled: true,
  },
];

const catalog = [
  { name: "fetch_page", description: "Fetch a documentation page" },
  { name: "search", description: "Search the documentation" },
  { name: "delete_index" },
];

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
      toolAllowlist: null,
      type: "local",
      command: ["npx", "tool"],
      revision: 3,
    });
  });

  describe("tool access", () => {
    it("summarizes restricted servers in the list", () => {
      render(<McpServersSettings />);

      expect(screen.getByRole("button", { name: /Server B/ })).toHaveTextContent("2 tools");
      expect(screen.getByRole("button", { name: /Server A/ })).not.toHaveTextContent("tools");
    });

    it("loads a saved remote server's tools and saves the selected ones", async () => {
      mocks.discoverMcpTools.mockResolvedValue(catalog);
      mocks.updateMcpServer.mockResolvedValue({ ...servers[0], revision: 4 });
      const user = userEvent.setup();
      render(<McpServersSettings />);

      await user.click(screen.getByRole("button", { name: /Server A/ }));
      await user.click(screen.getByRole("radio", { name: /Selected tools only/ }));
      expect(screen.getByText(/No tools selected/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Load tools" }));

      expect(mocks.discoverMcpTools).toHaveBeenCalledWith("server-a");
      await user.click(await screen.findByRole("checkbox", { name: /^search/ }));
      expect(screen.getByText("1 of 3 selected")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Save Changes" }));

      await waitFor(() =>
        expect(mocks.updateMcpServer).toHaveBeenCalledWith(
          "server-a",
          expect.objectContaining({ toolAllowlist: ["search"], revision: 3 })
        )
      );
    });

    it("keeps a stored selection and lets tools the server no longer offers be removed", async () => {
      mocks.discoverMcpTools.mockResolvedValue(catalog);
      mocks.updateMcpServer.mockResolvedValue({ ...servers[1], revision: 8 });
      const user = userEvent.setup();
      render(<McpServersSettings />);

      await user.click(screen.getByRole("button", { name: /Server B/ }));
      expect(screen.getByRole("radio", { name: /Selected tools only/ })).toBeChecked();
      await user.click(screen.getByRole("button", { name: "Load tools" }));

      expect(await screen.findByRole("checkbox", { name: /^search/ })).toBeChecked();
      expect(screen.getByText(/not offered by the server/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Remove retired_tool" }));
      await user.click(screen.getByRole("button", { name: "Save Changes" }));

      await waitFor(() =>
        expect(mocks.updateMcpServer).toHaveBeenCalledWith(
          "server-b",
          expect.objectContaining({ toolAllowlist: ["search"] })
        )
      );
    });

    it("selects and clears only the tools matching the search", async () => {
      mocks.discoverMcpTools.mockResolvedValue(catalog);
      const user = userEvent.setup();
      render(<McpServersSettings />);

      await user.click(screen.getByRole("button", { name: /Server A/ }));
      await user.click(screen.getByRole("radio", { name: /Selected tools only/ }));
      await user.click(screen.getByRole("button", { name: "Load tools" }));
      await user.type(await screen.findByRole("textbox", { name: "Search tools" }), "page");

      expect(screen.queryByRole("checkbox", { name: /^search/ })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Select all" }));
      await user.clear(screen.getByRole("textbox", { name: "Search tools" }));

      expect(screen.getByRole("checkbox", { name: /^fetch_page/ })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: /^search/ })).not.toBeChecked();
    });

    it("shows why loading failed", async () => {
      mocks.discoverMcpTools.mockRejectedValue(
        new Error("Could not load tools from the MCP server")
      );
      const user = userEvent.setup();
      render(<McpServersSettings />);

      await user.click(screen.getByRole("button", { name: /Server A/ }));
      await user.click(screen.getByRole("radio", { name: /Selected tools only/ }));
      await user.click(screen.getByRole("button", { name: "Load tools" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Could not load tools from the MCP server"
      );
    });

    it("loads tools only with the saved connection details", async () => {
      mocks.discoverMcpTools.mockResolvedValue([{ name: "search" }]);
      const user = userEvent.setup();
      render(<McpServersSettings />);

      await user.click(screen.getByRole("button", { name: /Server A/ }));
      await user.click(screen.getByRole("radio", { name: /Selected tools only/ }));
      await user.click(screen.getByRole("button", { name: "Load tools" }));
      expect(await screen.findByRole("checkbox", { name: /search/ })).toBeInTheDocument();
      await user.type(screen.getByDisplayValue("https://a.example.com"), "/v2");

      expect(
        screen.queryByRole("button", { name: /Load tools|Reload tools/ })
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("checkbox", { name: /search/ })).not.toBeInTheDocument();
      expect(screen.getByText(/Save the connection changes/)).toBeInTheDocument();
    });

    it("waits for typed headers to be saved before loading tools", async () => {
      const user = userEvent.setup();
      render(<McpServersSettings />);

      await user.click(screen.getByRole("button", { name: /Server A/ }));
      await user.click(screen.getByRole("radio", { name: /Selected tools only/ }));
      expect(screen.getByRole("button", { name: "Load tools" })).toBeInTheDocument();
      await user.type(screen.getByPlaceholderText("Header-Name"), "Authorization");
      await user.type(screen.getByPlaceholderText("value"), "Bearer new");

      expect(screen.queryByRole("button", { name: "Load tools" })).not.toBeInTheDocument();
      expect(screen.getByText(/Save the connection changes/)).toBeInTheDocument();
    });

    it("sends the selection when creating a server", async () => {
      mocks.createMcpServer.mockResolvedValue({ ...servers[2], id: "server-d", revision: 1 });
      const user = userEvent.setup();
      render(<McpServersSettings />);

      await user.click(screen.getByRole("button", { name: "Add Server" }));
      await user.type(screen.getByPlaceholderText("e.g. playwright, context7"), "playwright");
      await user.type(screen.getByPlaceholderText("npx -y @playwright/mcp"), "npx server-d");
      await user.click(screen.getByRole("radio", { name: /Selected tools only/ }));
      await user.type(screen.getByRole("textbox", { name: "Tool name" }), "navigate{Enter}");
      // The header button opens the form; the second "Add Server" submits it.
      const [, submit] = screen.getAllByRole("button", { name: "Add Server" });
      await user.click(submit);

      await waitFor(() =>
        expect(mocks.createMcpServer).toHaveBeenCalledWith(
          expect.objectContaining({ name: "playwright", toolAllowlist: ["navigate"] })
        )
      );
    });

    it("asks to save a new remote server before loading its tools", async () => {
      const user = userEvent.setup();
      render(<McpServersSettings />);

      await user.click(screen.getByRole("button", { name: "Add Server" }));
      await user.click(screen.getByRole("button", { name: "Remote" }));
      await user.click(screen.getByRole("radio", { name: /Selected tools only/ }));

      expect(screen.queryByRole("button", { name: "Load tools" })).not.toBeInTheDocument();
      expect(screen.getByText("Save the server to load its tools.")).toBeInTheDocument();
    });

    it("adds tool names by hand for local servers", async () => {
      mocks.updateMcpServer.mockResolvedValue({ ...servers[2], revision: 2 });
      const user = userEvent.setup();
      render(<McpServersSettings />);

      await user.click(screen.getByRole("button", { name: /Server C/ }));
      await user.click(screen.getByRole("radio", { name: /Selected tools only/ }));
      expect(screen.queryByRole("button", { name: "Load tools" })).not.toBeInTheDocument();
      expect(screen.getByText(/Local servers start inside the sandbox/)).toBeInTheDocument();
      await user.type(screen.getByRole("textbox", { name: "Tool name" }), " navigate {Enter}");
      await user.type(screen.getByRole("textbox", { name: "Tool name" }), "click");
      await user.click(screen.getByRole("button", { name: "Add" }));

      const selection = screen.getByRole("list", { name: "Selected tools" });
      expect(
        within(selection)
          .getAllByRole("listitem")
          .map((item) => item.textContent)
      ).toEqual(["navigate", "click"]);
      await user.click(screen.getByRole("button", { name: "Save Changes" }));

      await waitFor(() =>
        expect(mocks.updateMcpServer).toHaveBeenCalledWith(
          "server-c",
          expect.objectContaining({ toolAllowlist: ["click", "navigate"] })
        )
      );
    });

    it("restores every tool when switched back to All tools", async () => {
      mocks.updateMcpServer.mockResolvedValue({ ...servers[1], revision: 8 });
      const user = userEvent.setup();
      render(<McpServersSettings />);

      await user.click(screen.getByRole("button", { name: /Server B/ }));
      await user.click(screen.getByRole("radio", { name: /All tools/ }));
      await user.click(screen.getByRole("button", { name: "Save Changes" }));

      await waitFor(() =>
        expect(mocks.updateMcpServer).toHaveBeenCalledWith(
          "server-b",
          expect.objectContaining({ toolAllowlist: null })
        )
      );
    });
  });
});
