// @vitest-environment jsdom
import { afterEach, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { McpConnectionsSettings } from "./mcp-connections-settings";
const state = vi.hoisted(() => ({ fetch: vi.fn(), mutate: vi.fn(), status: "connected" }));
vi.mock("swr", () => ({
  default: () => ({
    data: {
      connections: [
        {
          serverId: "example",
          name: "Example",
          enabled: false,
          authMode: "user_oauth",
          status: state.status,
        },
      ],
    },
    mutate: state.mutate,
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: state.fetch }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.status = "connected";
});
it("lets an owner clear an abandoned OAuth reservation even after the server is disabled", async () => {
  state.status = "reconnect_required";
  state.fetch.mockResolvedValue(new Response("{}"));
  render(<McpConnectionsSettings />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Disconnect" }));
  await waitFor(() => expect(state.mutate).toHaveBeenCalledOnce());
  expect(state.fetch).toHaveBeenCalledWith("/api/mcp-connections/example", { method: "DELETE" });
});
it("allows self-disconnect even after an administrator disables the server", async () => {
  state.fetch.mockResolvedValue(new Response("{}"));
  render(<McpConnectionsSettings />);
  expect((screen.getByRole("button", { name: "Reconnect" }) as HTMLButtonElement).disabled).toBe(
    true
  );
  await userEvent.setup().click(screen.getByRole("button", { name: "Disconnect" }));
  await waitFor(() => expect(state.mutate).toHaveBeenCalledOnce());
  expect(state.fetch).toHaveBeenCalledWith("/api/mcp-connections/example", { method: "DELETE" });
  expect(screen.getByText(/session outputs remain shared/)).toBeTruthy();
});
