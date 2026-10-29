// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import { toast } from "sonner";
import { SecretsEditor } from "@/components/secrets-editor";
import type { TeamResponse } from "@/hooks/use-teams";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";
import { TeamSecrets } from "./team-secrets";

expect.extend(matchers);

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const denied = {
  canJoin: false,
  canLeave: false,
  canEditMetadata: false,
  canManageMembers: false,
  canManageRepositories: false,
  canManageBindings: false,
  canManageAutomations: false,
  canManageEnvironments: false,
  canManageSecrets: false,
  canArchive: false,
};
const allowed = { ...denied, canManageSecrets: true };
const fetchMock = vi.fn<typeof fetch>();
const maskedValuePlaceholder = "\u2022".repeat(8);

function renderSecrets(capabilities: TeamResponse["capabilities"] = allowed, teamId = "team_one") {
  return render(<TeamSecrets teamId={teamId} capabilities={capabilities} />, {
    wrapper: ({ children }) => (
      <SWRConfig
        value={{
          provider: () => new Map(),
          fetcher: async (path: BrowserApiPath) => {
            const response = await browserApiFetch(path);
            if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
            return response.json();
          },
          dedupingInterval: 0,
          revalidateOnFocus: false,
          revalidateOnReconnect: false,
          shouldRetryOnError: false,
        }}
      >
        {children}
      </SWRConfig>
    ),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => Response.json({ secrets: [] }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TeamSecrets", () => {
  it("lists team key metadata and inherited global keys using an encoded team id", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        secrets: [{ key: "API_TOKEN", createdAt: 1, updatedAt: 2 }],
        globalSecrets: [
          { key: "API_TOKEN", createdAt: 1, updatedAt: 2 },
          { key: "GLOBAL_ONLY", createdAt: 1, updatedAt: 1 },
        ],
      })
    );
    renderSecrets(allowed, "team_one/other");

    expect(await screen.findByDisplayValue("API_TOKEN")).toBeDisabled();
    expect(screen.getByText("GLOBAL_ONLY")).toBeInTheDocument();
    expect(screen.getByText("Inherited from global scope")).toBeInTheDocument();
    expect(screen.getByText("(overridden by team)")).toBeInTheDocument();
    expect(screen.getByText(/this team's sandbox work/)).toBeInTheDocument();
    expect(screen.getByText(/Global secrets are overridden by team secrets/)).toBeInTheDocument();
    expect(
      screen.getByText(/environment or repository secrets take precedence/)
    ).toBeInTheDocument();
    screen
      .getAllByPlaceholderText(maskedValuePlaceholder)
      .forEach((input) => expect(input).toHaveValue(""));
    expect(fetchMock).toHaveBeenCalledWith("/api/teams/team_one%2Fother/secrets", {
      mode: "same-origin",
      credentials: "same-origin",
    });
  });

  it("creates a team secret and refreshes the isolated SWR cache without retaining its value", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(Response.json({ secrets: [] }))
      .mockResolvedValueOnce(Response.json({ success: true }))
      .mockResolvedValueOnce(Response.json({ secrets: [{ key: "NEW_TOKEN" }] }));
    renderSecrets();
    await screen.findByText("No secrets set for this team.");

    await user.click(screen.getByRole("button", { name: "Add secret" }));
    await user.type(screen.getByPlaceholderText("KEY_NAME"), "new_token");
    await user.type(screen.getByPlaceholderText("value"), "new-secret-value");
    await user.click(screen.getByRole("button", { name: "Save secrets" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/teams/team_one/secrets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secrets: { NEW_TOKEN: "new-secret-value" } }),
      mode: "same-origin",
      credentials: "same-origin",
    });
    await waitFor(() => expect(screen.getByDisplayValue("NEW_TOKEN")).toBeDisabled());
    expect(screen.getByPlaceholderText(maskedValuePlaceholder)).toHaveValue("");
    expect(screen.queryByDisplayValue("new-secret-value")).not.toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith("Secrets updated");
  });

  it("updates an existing team key without submitting untouched keys", async () => {
    const user = userEvent.setup();
    const metadata = {
      secrets: [
        { key: "API_TOKEN", createdAt: 1, updatedAt: 1 },
        { key: "UNCHANGED", createdAt: 1, updatedAt: 1 },
      ],
    };
    fetchMock
      .mockResolvedValueOnce(Response.json(metadata))
      .mockResolvedValueOnce(Response.json({ success: true }))
      .mockResolvedValueOnce(
        Response.json({
          secrets: [
            { key: "API_TOKEN", createdAt: 1, updatedAt: 2 },
            { key: "UNCHANGED", createdAt: 1, updatedAt: 1 },
          ],
        })
      );
    renderSecrets();
    await screen.findByDisplayValue("API_TOKEN");

    await user.type(screen.getAllByPlaceholderText(maskedValuePlaceholder)[0], "replacement-value");
    await user.click(screen.getByRole("button", { name: "Save secrets" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/teams/team_one/secrets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secrets: { API_TOKEN: "replacement-value" } }),
      mode: "same-origin",
      credentials: "same-origin",
    });
    await waitFor(() =>
      expect(screen.getAllByPlaceholderText(maskedValuePlaceholder)[0]).toHaveValue("")
    );
    expect(screen.getByDisplayValue("UNCHANGED")).toBeInTheDocument();
  });

  it("deletes an existing team key and refreshes the list", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(Response.json({ secrets: [{ key: "API_TOKEN" }] }))
      .mockResolvedValueOnce(Response.json({ success: true }))
      .mockResolvedValueOnce(Response.json({ secrets: [] }));
    renderSecrets();
    await screen.findByDisplayValue("API_TOKEN");

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/teams/team_one/secrets/API_TOKEN", {
      method: "DELETE",
      mode: "same-origin",
      credentials: "same-origin",
    });
    await screen.findByText("No secrets set for this team.");
    expect(screen.queryByDisplayValue("API_TOKEN")).not.toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith("Deleted API_TOKEN");
  });

  it.each([denied, { canManageSecrets: true }, { ...allowed, canArchive: undefined }])(
    "does not mount or fetch the editor with denied or incomplete capabilities %s",
    (capabilities) => {
      renderSecrets(capabilities);
      expect(screen.queryByRole("button", { name: "Add secret" })).not.toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("fails closed when the server omits capabilities", () => {
    render(<TeamSecrets teamId="team_one" />);
    expect(screen.queryByRole("heading", { name: "Secrets" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("unmounts editable values when the server revokes secret management", async () => {
    const user = userEvent.setup();
    const view = renderSecrets();
    await screen.findByText("No secrets set for this team.");
    await user.click(screen.getByRole("button", { name: "Add secret" }));
    await user.type(screen.getByPlaceholderText("KEY_NAME"), "DRAFT_TOKEN");
    await user.type(screen.getByPlaceholderText("value"), "unsaved-value");

    view.rerender(<TeamSecrets teamId="team_one" capabilities={denied} />);

    expect(screen.queryByDisplayValue("unsaved-value")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save secrets" })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not carry an unsaved value into another team's editor", async () => {
    const user = userEvent.setup();
    const view = renderSecrets();
    await screen.findByText("No secrets set for this team.");
    await user.click(screen.getByRole("button", { name: "Add secret" }));
    await user.type(screen.getByPlaceholderText("KEY_NAME"), "DRAFT_TOKEN");
    await user.type(screen.getByPlaceholderText("value"), "unsaved-value");

    view.rerender(<TeamSecrets teamId="team_two" capabilities={allowed} />);

    await screen.findByText("No secrets set for this team.");
    expect(screen.queryByDisplayValue("unsaved-value")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("DRAFT_TOKEN")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/teams/team_two/secrets", {
      mode: "same-origin",
      credentials: "same-origin",
    });
  });

  it("shows load failures without retrying or exposing key values", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "Forbidden" }, { status: 403 }));
    renderSecrets();

    expect(await screen.findByText("Failed to load secrets")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("KEY_NAME")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the team scope unaddressable without a team id", () => {
    render(<SecretsEditor scope="team" />);

    expect(screen.getByText("Select a team to manage secrets.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add secret" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revalidates the mutation's original scope after an editor switches targets", async () => {
    const user = userEvent.setup();
    let finishMutation: ((response: Response) => void) | undefined;
    fetchMock.mockImplementation(async (url, init) => {
      if (init?.method === "PUT") {
        return new Promise<Response>((resolve) => {
          finishMutation = resolve;
        });
      }
      return Response.json({
        secrets: [{ key: url.toString().includes("team_two") ? "SECOND" : "FIRST" }],
      });
    });
    const view = renderSecrets();
    // Use the shared editor without a remount key, as the settings scope picker does.
    view.rerender(<SecretsEditor scope="team" teamId="team_one" />);
    await screen.findByDisplayValue("FIRST");
    await user.type(screen.getByPlaceholderText(maskedValuePlaceholder), "replacement");
    await user.click(screen.getByRole("button", { name: "Save secrets" }));
    view.rerender(<SecretsEditor scope="team" teamId="team_two" />);
    await screen.findByDisplayValue("SECOND");
    await user.type(screen.getByPlaceholderText(maskedValuePlaceholder), "second-draft");
    await act(async () => {
      finishMutation?.(Response.json({ status: "updated" }));
    });
    expect(screen.getByPlaceholderText(maskedValuePlaceholder)).toHaveValue("second-draft");
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => url === "/api/teams/team_two/secrets" && !init?.method
      )
    ).toHaveLength(1);
  });
});
