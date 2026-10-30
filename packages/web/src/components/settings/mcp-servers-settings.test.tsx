// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { toast } from "sonner";
import type { McpServerMetadata } from "@open-inspect/shared/types/integrations";
import type * as McpServersModule from "@/hooks/use-mcp-servers";
import { McpServersSettings } from "./mcp-servers-settings";

expect.extend(matchers);

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  updateMcpServer: vi.fn(),
  browserApiFetch: vi.fn(),
  allowedPermissions: null as Set<string> | null,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: mocks.browserApiFetch }));
vi.mock("@/hooks/use-repos", () => ({
  useRepos: () => ({ repos: [], loading: false }),
}));
// Delete and revoke stay real so their requests and refusals reach the component as sent.
vi.mock("@/hooks/use-mcp-servers", async (importOriginal) => ({
  ...(await importOriginal<typeof McpServersModule>()),
  useMcpServers: () => ({ servers, loading: false, mutate: mocks.mutate }),
  createMcpServer: vi.fn(),
  updateMcpServer: mocks.updateMcpServer,
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
    credentialKeys: [],
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
    credentialKeys: [],
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
    credentialKeys: ["x-api-key", "Accept"],
    repoScopes: null,
    enabled: true,
  },
  {
    id: "server-oauth-off",
    revision: 5,
    name: "Disabled OAuth",
    type: "remote",
    url: "https://oauth-off.example.com/mcp",
    hasEnv: false,
    hasHeaders: false,
    credentialKeys: [],
    repoScopes: null,
    enabled: false,
    authMode: "user_oauth",
    managedRouting: true,
    oauth: { issuer: "https://issuer.example.com", resource: "https://oauth-off.example.com/mcp" },
  },
  {
    id: "server-oauth-on",
    revision: 1,
    name: "Enabled OAuth",
    type: "remote",
    url: "https://oauth-on.example.com/mcp",
    hasEnv: false,
    hasHeaders: false,
    credentialKeys: [],
    repoScopes: null,
    enabled: true,
    authMode: "user_oauth",
    managedRouting: true,
    oauth: { issuer: "https://issuer.example.com", resource: "https://oauth-on.example.com/mcp" },
  },
  {
    id: "server-service-off",
    revision: 1,
    name: "Disabled Service",
    type: "remote",
    url: "https://service-off.example.com/mcp",
    hasEnv: false,
    hasHeaders: false,
    credentialKeys: [],
    repoScopes: null,
    enabled: false,
    authMode: "service_credentials",
  },
];

/** The header row holding a server's name and its actions. */
function serverRow(name: RegExp): HTMLElement {
  return screen.getByRole("button", { name }).parentElement!;
}

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
    expect(screen.queryByRole("button", { name: "Revoke connections" })).not.toBeInTheDocument();
  });

  it("offers to revoke connections only for disabled remote servers", () => {
    render(<McpServersSettings />);

    // A server that left personal OAuth keeps its grants, so it offers revocation too.
    expect(screen.getAllByRole("button", { name: "Revoke connections" })).toHaveLength(2);
    for (const name of [/Disabled OAuth/, /Disabled Service/])
      expect(
        within(serverRow(name)).getByRole("button", { name: "Revoke connections" })
      ).toBeInTheDocument();
    expect(
      within(serverRow(/Enabled OAuth/)).queryByRole("button", { name: "Revoke connections" })
    ).not.toBeInTheDocument();
  });

  it("revokes every user's connections only after confirmation, then refreshes", async () => {
    mocks.browserApiFetch.mockResolvedValue(Response.json({ ok: true }));
    const user = userEvent.setup();
    render(<McpServersSettings />);

    await user.click(
      within(serverRow(/Disabled OAuth/)).getByRole("button", { name: "Revoke connections" })
    );
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("every user’s personal connection to this server");
    expect(mocks.browserApiFetch).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Revoke connections" }));

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledOnce());
    expect(mocks.browserApiFetch).toHaveBeenCalledExactlyOnceWith(
      "/api/mcp-servers/server-oauth-off/revoke-connections",
      { method: "POST" }
    );
    expect(toast.success).toHaveBeenCalledWith("MCP connections revoked");
  });

  it("explains how to delete a server that users are still connected to", async () => {
    mocks.browserApiFetch.mockResolvedValue(
      Response.json(
        {
          error: "Disable this server, then disconnect its personal connections before deleting it",
        },
        { status: 409 }
      )
    );
    const user = userEvent.setup();
    render(<McpServersSettings />);

    await user.click(within(serverRow(/Disabled OAuth/)).getByRole("button", { name: "Delete" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" })
    );

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Users are still connected to this server. Disable it and revoke its connections, then delete it."
      )
    );
    expect(mocks.browserApiFetch).toHaveBeenCalledExactlyOnceWith(
      "/api/mcp-servers/server-oauth-off",
      { method: "DELETE" }
    );
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("shows the server's reason for any other delete failure", async () => {
    mocks.browserApiFetch.mockResolvedValue(
      Response.json({ error: "MCP server not found" }, { status: 404 })
    );
    const user = userEvent.setup();
    render(<McpServersSettings />);

    await user.click(within(serverRow(/Disabled OAuth/)).getByRole("button", { name: "Delete" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" })
    );

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("MCP server not found"));
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

  it("lists saved headers by name with their values hidden", async () => {
    const user = userEvent.setup();
    render(<McpServersSettings />);

    await user.click(screen.getByRole("button", { name: /Server C/ }));

    expect(screen.getByDisplayValue("x-api-key")).toBeDisabled();
    expect(screen.getByDisplayValue("Accept")).toBeDisabled();
    const hiddenValues = screen.getAllByPlaceholderText("••••••••");
    expect(hiddenValues).toHaveLength(2);
    for (const input of hiddenValues) expect(input).toHaveValue("");
  });

  it("replaces an edited saved header and keeps the untouched one", async () => {
    mocks.updateMcpServer.mockResolvedValue({ ...servers[2], revision: 3 });
    const user = userEvent.setup();
    render(<McpServersSettings />);

    await user.click(screen.getByRole("button", { name: /Server C/ }));
    await user.type(screen.getAllByPlaceholderText("••••••••")[0], "new-key");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mocks.updateMcpServer).toHaveBeenCalledWith(
        "server-c",
        expect.objectContaining({
          headers: { "x-api-key": "new-key" },
          keepCredentialKeys: ["Accept"],
          revision: 2,
        })
      )
    );
  });

  it("deletes a removed saved header on save", async () => {
    mocks.updateMcpServer.mockResolvedValue({ ...servers[2], revision: 3 });
    const user = userEvent.setup();
    render(<McpServersSettings />);

    await user.click(screen.getByRole("button", { name: /Server C/ }));
    await user.click(screen.getAllByRole("button", { name: "Remove" })[1]);
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mocks.updateMcpServer).toHaveBeenCalledWith(
        "server-c",
        expect.objectContaining({ headers: {}, keepCredentialKeys: ["x-api-key"] })
      )
    );
  });

  it("keeps every saved header by name when none is edited", async () => {
    mocks.updateMcpServer.mockResolvedValue({ ...servers[2], revision: 3 });
    const user = userEvent.setup();
    render(<McpServersSettings />);

    await user.click(screen.getByRole("button", { name: /Server C/ }));
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mocks.updateMcpServer).toHaveBeenCalledWith("server-c", {
        name: "Server C",
        enabled: true,
        repoScopes: null,
        type: "remote",
        url: "https://c.example.com",
        authMode: "service_credentials",
        managedRouting: false,
        oauth: null,
        headers: {},
        keepCredentialKeys: ["x-api-key", "Accept"],
        revision: 2,
      })
    );
  });

  it("restores the saved headers when the type is switched away and back", async () => {
    mocks.updateMcpServer.mockResolvedValue({ ...servers[2], revision: 3 });
    const user = userEvent.setup();
    render(<McpServersSettings />);

    await user.click(screen.getByRole("button", { name: /Server C/ }));
    await user.click(screen.getByRole("button", { name: "Local" }));
    expect(screen.queryByDisplayValue("x-api-key")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remote" }));
    expect(screen.getByDisplayValue("x-api-key")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mocks.updateMcpServer).toHaveBeenCalledWith(
        "server-c",
        expect.objectContaining({ headers: {}, keepCredentialKeys: ["x-api-key", "Accept"] })
      )
    );
  });

  it("restores the saved headers when the auth mode is switched away and back", async () => {
    mocks.updateMcpServer.mockResolvedValue({ ...servers[2], revision: 3 });
    const user = userEvent.setup();
    render(<McpServersSettings />);

    await user.click(screen.getByRole("button", { name: /Server C/ }));
    await user.click(screen.getByRole("combobox", { name: "Authentication" }));
    await user.click(screen.getByRole("option", { name: "No upstream authentication" }));
    expect(screen.queryByDisplayValue("x-api-key")).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Authentication" }));
    await user.click(screen.getByRole("option", { name: "Shared service credentials" }));
    expect(screen.getByDisplayValue("x-api-key")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mocks.updateMcpServer).toHaveBeenCalledWith(
        "server-c",
        expect.objectContaining({
          authMode: "service_credentials",
          headers: {},
          keepCredentialKeys: ["x-api-key", "Accept"],
        })
      )
    );
  });

  it.each([
    {
      mode: "none",
      option: "No upstream authentication",
      auth: { authMode: "none", managedRouting: false, oauth: null },
    },
    {
      mode: "user_oauth",
      option: /Each user/,
      auth: {
        authMode: "user_oauth",
        managedRouting: true,
        oauth: { issuer: "https://issuer.example.com", resource: "https://c.example.com" },
      },
    },
  ])(
    "keeps no saved header after choosing $mode and switching the type away and back",
    async ({ option, auth }) => {
      mocks.updateMcpServer.mockResolvedValue({ ...servers[2], revision: 3 });
      const user = userEvent.setup();
      render(<McpServersSettings />);

      await user.click(screen.getByRole("button", { name: /Server C/ }));
      await user.click(screen.getByRole("combobox", { name: "Authentication" }));
      await user.click(screen.getByRole("option", { name: option }));
      if (auth.oauth) {
        await user.type(
          screen.getByPlaceholderText("https://gateway.example.com/mcp"),
          auth.oauth.issuer
        );
      }
      await user.click(screen.getByRole("button", { name: "Local" }));
      await user.click(screen.getByRole("button", { name: "Remote" }));
      await user.click(screen.getByRole("button", { name: "Save Changes" }));

      // Kept names would retain the stored headers, which this mode refuses.
      await waitFor(() =>
        expect(mocks.updateMcpServer).toHaveBeenCalledWith("server-c", {
          name: "Server C",
          enabled: true,
          repoScopes: null,
          type: "remote",
          url: "https://c.example.com",
          ...auth,
          headers: {},
          revision: 2,
        })
      );
    }
  );

  it("clears every saved header when all saved rows are removed", async () => {
    mocks.updateMcpServer.mockResolvedValue({ ...servers[2], revision: 3 });
    const user = userEvent.setup();
    render(<McpServersSettings />);

    await user.click(screen.getByRole("button", { name: /Server C/ }));
    await user.click(screen.getAllByRole("button", { name: "Remove" })[1]);
    await user.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mocks.updateMcpServer).toHaveBeenCalledWith(
        "server-c",
        expect.objectContaining({ headers: {}, keepCredentialKeys: [] })
      )
    );
  });

  it("renames a saved header by removing it and adding a new row", async () => {
    mocks.updateMcpServer.mockResolvedValue({ ...servers[2], revision: 3 });
    const user = userEvent.setup();
    render(<McpServersSettings />);

    await user.click(screen.getByRole("button", { name: /Server C/ }));
    await user.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    await user.click(screen.getByRole("button", { name: "+ Add" }));
    await user.type(screen.getAllByPlaceholderText("Header-Name").at(-1)!, "X-Token");
    await user.type(screen.getByPlaceholderText("value"), "tok");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mocks.updateMcpServer).toHaveBeenCalledWith(
        "server-c",
        expect.objectContaining({ headers: { "X-Token": "tok" }, keepCredentialKeys: ["Accept"] })
      )
    );
  });

  it("sends no per-name update when the saved type changes", async () => {
    mocks.updateMcpServer.mockResolvedValue({ ...servers[2], type: "local", revision: 3 });
    const user = userEvent.setup();
    render(<McpServersSettings />);

    await user.click(screen.getByRole("button", { name: /Server C/ }));
    await user.click(screen.getByRole("button", { name: "Local" }));
    await user.type(screen.getByPlaceholderText("npx -y @playwright/mcp"), "npx tool");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mocks.updateMcpServer).toHaveBeenCalledWith("server-c", {
        name: "Server C",
        enabled: true,
        repoScopes: null,
        type: "local",
        command: ["npx", "tool"],
        revision: 2,
      })
    );
  });

  it("sends no credentials for a server without saved names", async () => {
    mocks.updateMcpServer.mockResolvedValue({ ...servers[0], revision: 4 });
    const user = userEvent.setup();
    render(<McpServersSettings />);

    await user.click(screen.getByRole("button", { name: /Server A/ }));
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mocks.updateMcpServer).toHaveBeenCalledWith("server-a", {
        name: "Server A",
        enabled: true,
        repoScopes: null,
        type: "remote",
        url: "https://a.example.com",
        authMode: "service_credentials",
        managedRouting: false,
        oauth: null,
        revision: 3,
      })
    );
  });

  it("falls back to the generic notice when saved credentials come without names", async () => {
    // Callers without mcp_servers.manage and older control planes get no credentialKeys.
    const { credentialKeys: _omitted, ...unnamed } = servers[2];
    servers.push({ ...unnamed, id: "server-d", name: "Server D" });
    mocks.updateMcpServer.mockResolvedValue({ ...unnamed, id: "server-d", revision: 3 });
    try {
      const user = userEvent.setup();
      render(<McpServersSettings />);

      await user.click(screen.getByRole("button", { name: /Server D/ }));

      expect(
        screen.getByText(
          "Credentials are configured. Enter new values to replace them, or leave empty to keep existing."
        )
      ).toBeInTheDocument();
      expect(screen.queryByPlaceholderText("••••••••")).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Save Changes" }));
      await waitFor(() =>
        expect(mocks.updateMcpServer).toHaveBeenCalledWith("server-d", {
          name: "Server D",
          enabled: true,
          repoScopes: null,
          type: "remote",
          url: "https://c.example.com",
          authMode: "service_credentials",
          managedRouting: false,
          oauth: null,
          revision: 2,
        })
      );
    } finally {
      servers.pop();
    }
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

  it("selects personal OAuth through the shared control and clears service credentials", async () => {
    mocks.updateMcpServer.mockResolvedValue({ ...servers[0], revision: 4 });
    const user = userEvent.setup();
    render(<McpServersSettings />);
    await user.click(screen.getByRole("button", { name: /Server A/ }));
    await user.type(screen.getByPlaceholderText("Header-Name"), "Authorization");
    await user.type(screen.getByPlaceholderText("value"), "service-secret");
    await user.click(screen.getByRole("combobox", { name: "Authentication" }));
    await user.click(screen.getByRole("option", { name: /Each user/ }));
    expect(screen.queryByPlaceholderText("Header-Name")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Route through Open Inspect" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Route through Open Inspect" })).toBeDisabled();
    await user.type(
      screen.getByPlaceholderText("https://gateway.example.com/mcp"),
      "https://issuer.example.com"
    );
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(mocks.updateMcpServer).toHaveBeenCalledWith(
      "server-a",
      expect.objectContaining({
        authMode: "user_oauth",
        managedRouting: true,
        headers: {},
        oauth: { issuer: "https://issuer.example.com", resource: "https://a.example.com" },
      })
    );
  });
});
