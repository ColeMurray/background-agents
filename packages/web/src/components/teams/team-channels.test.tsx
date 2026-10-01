// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamResponse } from "@/hooks/use-teams";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { TeamChannels } from "./team-channels";

expect.extend(matchers);
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));
vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { id: "user_one" } } }),
}));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}
    >
      {children}
    </SWRConfig>
  );
}

const team: TeamResponse = {
  id: "team/id",
  slug: "design",
  name: "Design",
  description: null,
  joinPolicy: "invite_only",
  defaultVisibility: "team",
  defaultEnvironmentId: null,
  grantsVersion: 0,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  memberCount: 1,
  capabilities: {
    canJoin: false,
    canLeave: false,
    canEditMetadata: false,
    canManageMembers: false,
    canManageRepositories: false,
    canManageBindings: true,
    canManageAutomations: false,
    canManageSecrets: false,
    canArchive: false,
  },
};
const key = "/api/teams/team%2Fid/channel-bindings";
const bindings = [
  { provider: "slack", externalId: "C_HOME", teamId: team.id, kind: "primary" },
  { provider: "slack", externalId: "C_SOURCE", teamId: team.id, kind: "source" },
  { provider: "linear", externalId: "linear_team", teamId: team.id, kind: "source" },
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(browserApiFetch).mockResolvedValue(Response.json({ bindings: [] }));
});
afterEach(cleanup);

describe("Team channels", () => {
  it.each([
    undefined,
    {},
    { canManageBindings: true },
    { ...team.capabilities, canManageBindings: false },
  ])(
    "does not fetch bindings or enable controls without complete server capabilities: %s",
    (capabilities) => {
      render(<TeamChannels team={{ ...team, capabilities }} />, { wrapper });
      expect(browserApiFetch).not.toHaveBeenCalled();
      expect(screen.getByRole("textbox", { name: "Slack channel ID" })).toBeDisabled();
      expect(screen.getByRole("combobox", { name: "Binding kind" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Bind channel" })).toBeDisabled();
      expect(screen.getByText(/do not have permission to view or manage/i)).toBeInTheDocument();
    }
  );

  it.each(["primary", "source"])(
    "binds a trimmed Slack channel ID as %s and refreshes",
    async (kind) => {
      vi.mocked(browserApiFetch).mockResolvedValueOnce(Response.json({ bindings: [bindings[0]] }));
      render(<TeamChannels team={team} />, { wrapper });
      await screen.findByText("C_HOME");
      expect(screen.getByRole("button", { name: "Bind channel" })).toBeDisabled();
      fireEvent.change(screen.getByRole("textbox", { name: "Slack channel ID" }), {
        target: { value: " C_NEW/ID " },
      });
      fireEvent.change(screen.getByRole("combobox", { name: "Binding kind" }), {
        target: { value: kind },
      });
      let finish!: (response: Response) => void;
      const mutation = new Promise<Response>((resolve) => {
        finish = resolve;
      });
      vi.mocked(browserApiFetch)
        .mockReturnValueOnce(mutation)
        .mockResolvedValueOnce(
          Response.json({ bindings: [{ ...bindings[0], externalId: "C_NEW/ID", kind }] })
        );
      fireEvent.click(screen.getByRole("button", { name: "Bind channel" }));
      expect(screen.getByRole("textbox", { name: "Slack channel ID" })).toBeDisabled();
      expect(screen.getByRole("combobox", { name: "Binding kind" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Unbind Slack channel C_HOME" })).toBeDisabled();
      await act(async () => {
        finish(Response.json({ ok: true }));
      });
      expect(await screen.findByText("C_NEW/ID")).toBeInTheDocument();
      expect(browserApiFetch).toHaveBeenCalledWith(`${key}/slack/C_NEW%2FID`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      expect(screen.getByRole("textbox", { name: "Slack channel ID" })).toHaveValue("");
      await waitFor(() =>
        expect(screen.getByRole("textbox", { name: "Slack channel ID" })).toBeEnabled()
      );
    }
  );

  it("unbinds Slack channels and reloads the authoritative list", async () => {
    vi.mocked(browserApiFetch).mockResolvedValueOnce(Response.json({ bindings }));
    render(<TeamChannels team={team} />, { wrapper });
    const unbind = await screen.findByRole("button", { name: "Unbind Slack channel C_HOME" });
    const rows = within(screen.getByRole("list", { name: "Channel bindings" }));
    expect(rows.getByText("C_HOME")).toBeInTheDocument();
    expect(rows.getByText("Primary")).toBeInTheDocument();
    expect(rows.getAllByText("Source")).toHaveLength(2);
    expect(rows.getByText("linear_team")).toBeInTheDocument();
    expect(rows.queryByRole("button", { name: /Unbind.*linear_team/ })).not.toBeInTheDocument();
    expect(browserApiFetch).toHaveBeenCalledWith(key);
    vi.mocked(browserApiFetch)
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ bindings: [] }));
    fireEvent.click(unbind);
    await screen.findByText("No channel bindings yet.");
    expect(browserApiFetch).toHaveBeenCalledWith(`${key}/slack/C_HOME`, { method: "DELETE" });
    expect(screen.queryByText("C_HOME")).not.toBeInTheDocument();
  });

  it("shows server refusal codes without clearing the draft or claiming success", async () => {
    render(<TeamChannels team={team} />, { wrapper });
    await screen.findByText("No channel bindings yet.");
    fireEvent.change(screen.getByRole("textbox", { name: "Slack channel ID" }), {
      target: { value: "C_SHARED" },
    });
    vi.mocked(browserApiFetch).mockResolvedValueOnce(
      Response.json(
        { error: "Channel is not joinable", code: "channel_not_joinable" },
        { status: 409 }
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "Bind channel" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("channel_not_joinable");
    expect(screen.getByRole("textbox", { name: "Slack channel ID" })).toHaveValue("C_SHARED");
    expect(browserApiFetch).toHaveBeenCalledTimes(2);
  });

  it("withholds cached rows immediately when capabilities are revoked", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(Response.json({ bindings }));
    const view = render(<TeamChannels team={team} />, { wrapper });
    await screen.findByText("C_HOME");
    vi.mocked(browserApiFetch).mockClear();
    view.rerender(<TeamChannels team={{ ...team, capabilities: undefined }} />);
    expect(screen.queryByText("C_HOME")).not.toBeInTheDocument();
    expect(screen.queryByText("linear_team")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bind channel" })).toBeDisabled();
    expect(browserApiFetch).not.toHaveBeenCalled();
  });

  it("shows a load error rather than an empty list and supports retry", async () => {
    vi.mocked(browserApiFetch).mockResolvedValueOnce(
      Response.json({ error: "Forbidden" }, { status: 403 })
    );
    render(<TeamChannels team={team} />, { wrapper });
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load channel bindings.");
    expect(screen.queryByText("No channel bindings yet.")).not.toBeInTheDocument();
    vi.mocked(browserApiFetch).mockResolvedValueOnce(Response.json({ bindings: [] }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No channel bindings yet.")).toBeInTheDocument();
  });
});
