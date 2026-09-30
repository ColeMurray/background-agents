// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TeamResponse } from "@/hooks/use-teams";
import type { TeamRole } from "@open-inspect/shared/types/teams";
import { environment, mocks, repo, sessionCreateBody } from "./page.test-fixture";
import Home from "./page";

// Radix Select uses pointer-capture APIs that jsdom doesn't implement.
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
});

async function selectTeam(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("combobox", { name: "Team context" }));
  await user.click(await screen.findByRole("option", { name }));
}

async function selectAudience(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole("button", { name: /^Session access:/ }));
  await user.click(screen.getByRole("radio", { name: label }));
}

function team(overrides: Partial<TeamResponse> = {}): TeamResponse & { role: TeamRole } {
  return {
    id: "team-1",
    slug: "engineering",
    name: "Engineering",
    description: null,
    joinPolicy: "invite_only",
    defaultVisibility: "team",
    defaultEnvironmentId: null,
    grantsVersion: 0,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    memberCount: 1,
    role: "member",
    ...overrides,
  };
}

describe("Home team context", () => {
  it("separates icon-led session access from the agent controls", async () => {
    const user = userEvent.setup();
    mocks.teams = [team()];
    render(<Home />);
    const trigger = screen.getByRole("button", {
      name: "Session access: Workspace; team context: No team",
    });
    expect(trigger).toHaveTextContent("Workspace");
    expect(trigger.querySelector('svg[aria-hidden="true"]')).toBeInTheDocument();
    await user.click(trigger);
    const context = screen.getByRole("dialog", { name: "Session access" });
    expect(within(context).getByRole("combobox", { name: "Team context" })).toHaveTextContent(
      "No team"
    );
    expect(
      within(context).getByRole("radiogroup", { name: "Session audience" })
    ).toBeInTheDocument();
    expect(
      within(context).queryByRole("button", { name: /model and effort/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Manage secrets and settings" })
    ).not.toBeInTheDocument();
  });

  it("defaults workspace drafts to workspace visibility with team visibility disabled", async () => {
    const user = userEvent.setup();
    render(<Home />);
    const visibility = screen.getByRole("button", { name: /^Session access: Workspace;/ });
    expect(visibility.tagName).toBe("BUTTON");
    expect(visibility).toHaveTextContent("Workspace");
    await user.click(visibility);
    const menu = screen.getByRole("radiogroup", { name: "Session audience" });
    expect(within(menu).getByRole("radio", { name: "Workspace" })).toBeChecked();
    expect(within(menu).getByRole("radio", { name: "Team" })).toBeDisabled();
    await user.keyboard("{Escape}");
    await user.type(screen.getByPlaceholderText("What do you want to build?"), "Ship it");
    await waitFor(() =>
      expect(sessionCreateBody()).toMatchObject({ teamId: null, visibility: "workspace" })
    );
  });

  it("uses the active team's defaults and archives the warm draft on visibility and team changes", async () => {
    const user = userEvent.setup();
    mocks.teams = [team(), team({ id: "team-2", name: "Design", defaultVisibility: "private" })];
    mocks.activeTeamId = "team-1";
    const view = render(<Home />);
    await user.type(screen.getByPlaceholderText("What do you want to build?"), "Ship it");
    await waitFor(() =>
      expect(sessionCreateBody()).toMatchObject({ teamId: "team-1", visibility: "team" })
    );
    await selectAudience(user, "Workspace");
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/sessions/session-1/archive", expect.anything())
    );
    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/sessions")
      ).toHaveLength(2)
    );
    const workspaceCall = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url) === "/api/sessions")[1];
    expect(JSON.parse(String(workspaceCall[1]?.body))).toMatchObject({
      teamId: "team-1",
      visibility: "workspace",
    });
    mocks.activeTeamId = "team-2";
    view.rerender(<Home />);
    expect(
      screen.getByRole("button", { name: "Session access: Private; team context: Design" })
    ).toHaveTextContent("Private");
    await waitFor(() => {
      const calls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/sessions");
      expect(calls).toHaveLength(3);
      expect(JSON.parse(String(calls[2][1]?.body))).toMatchObject({
        teamId: "team-2",
        visibility: "private",
      });
    });
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => String(url) === "/api/sessions/session-1/archive")
    ).toHaveLength(2);
  });

  it("offers a composer team choice, preserves Workspace access, and maps No team to null", async () => {
    const user = userEvent.setup();
    mocks.teams = [team()];
    const view = render(<Home />);
    const trigger = screen.getByRole("button", { name: /^Session access:/ });
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger).toHaveTextContent("Workspace");
    await user.click(trigger);
    await selectTeam(user, "Engineering");
    expect(mocks.setActiveTeam).toHaveBeenCalledWith("team-1");
    mocks.activeTeamId = "team-1";
    view.rerender(<Home />);
    expect(trigger).toHaveAccessibleName("Session access: Workspace; team context: Engineering");
    expect(screen.getByRole("combobox", { name: "Team context" })).toHaveTextContent("Engineering");
    await selectTeam(user, "No team");
    expect(mocks.setActiveTeam).toHaveBeenLastCalledWith(null);
    mocks.activeTeamId = null;
    view.rerender(<Home />);
    expect(trigger).toHaveAccessibleName("Session access: Workspace; team context: No team");
    await user.keyboard("{Escape}");
    await user.type(screen.getByPlaceholderText("What do you want to build?"), "Ship it");
    await waitFor(() =>
      expect(sessionCreateBody()).toMatchObject({ teamId: null, visibility: "workspace" })
    );
  });

  it("preserves Private access when the composer team context changes and warms the final pair", async () => {
    const user = userEvent.setup();
    mocks.teams = [team(), team({ id: "team-2", name: "Design", defaultVisibility: "workspace" })];
    mocks.activeTeamId = "team-1";
    const view = render(<Home />);
    mocks.setActiveTeam.mockImplementation((teamId: string | null) => {
      mocks.activeTeamId = teamId;
      view.rerender(<Home />);
    });
    await selectAudience(user, "Private");
    await user.type(screen.getByPlaceholderText("What do you want to build?"), "Ship it");
    await waitFor(() =>
      expect(sessionCreateBody()).toMatchObject({ teamId: "team-1", visibility: "private" })
    );
    await user.click(screen.getByRole("button", { name: /^Session access:/ }));
    await selectTeam(user, "Design");
    expect(mocks.setActiveTeam).toHaveBeenCalledWith("team-2");
    expect(
      screen.getByRole("button", { name: "Session access: Private; team context: Design" })
    ).toHaveTextContent("Private");
    expect(screen.getByRole("radio", { name: "Private" })).toBeChecked();
    await waitFor(() => {
      const calls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/sessions");
      expect(calls).toHaveLength(2);
      expect(JSON.parse(String(calls[1][1]?.body))).toMatchObject({
        teamId: "team-2",
        visibility: "private",
      });
    });
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => String(url) === "/api/sessions/session-1/archive")
    ).toHaveLength(1);
  });

  it("selects visibility with the keyboard and restores focus to its trigger", async () => {
    const user = userEvent.setup();
    render(<Home />);
    const trigger = screen.getByRole("button", { name: /^Session access:/ });
    trigger.focus();
    expect(trigger).toHaveFocus();
    await user.keyboard("[Space]");
    await waitFor(() => expect(screen.getByRole("radio", { name: "Workspace" })).toHaveFocus());
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("radio", { name: "Private" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: "Workspace" })).toBeChecked();
    await user.keyboard("{Enter}");
    expect(trigger).toHaveTextContent("Private");
    expect(screen.queryByRole("dialog", { name: "Session access" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("waits for membership and settings reconciliation before warming or sending", async () => {
    const user = userEvent.setup();
    mocks.teamsLoading = true;
    mocks.teams = [team()];
    const view = render(<Home />);
    const input = screen.getByPlaceholderText("What do you want to build?");
    await user.type(input, "Ship it");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Session access:/ })).toBeDisabled();
    expect(fetch).not.toHaveBeenCalled();
    mocks.teamsLoading = false;
    mocks.requireTeamOnCreate = true;
    mocks.teams = [team()];
    view.rerender(<Home />);
    expect(mocks.setActiveTeam).toHaveBeenCalledWith("team-1");
    await user.click(screen.getByRole("button", { name: /^Session access:/ }));
    expect(screen.getByRole("combobox", { name: "Team context" })).not.toBeDisabled();
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toBeDisabled();
    }
    await user.click(screen.getByRole("combobox", { name: "Team context" }));
    expect(screen.queryByRole("option", { name: "No team" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}{Escape}");
    expect(fetch).not.toHaveBeenCalled();
    mocks.activeTeamId = "team-1";
    view.rerender(<Home />);
    await waitFor(() =>
      expect(sessionCreateBody()).toMatchObject({ teamId: "team-1", visibility: "team" })
    );
  });

  it("blocks warming and shortcut submission with an inline notice when a team is required but none are available", async () => {
    const user = userEvent.setup();
    mocks.requireTeamOnCreate = true;
    render(<Home />);
    expect(screen.getByText("Join a team to create a session.")).toBeInTheDocument();
    const input = screen.getByPlaceholderText("What do you want to build?");
    await user.type(input, "Ship it");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not create workspace drafts when the team context failed to load", async () => {
    const user = userEvent.setup();
    mocks.teamsError = new Error("Settings unavailable");
    render(<Home />);
    await user.type(screen.getByPlaceholderText("What do you want to build?"), "Ship it");
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Session access:/ })).toBeDisabled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces terminal creation codes on first typing and does not retry the denied draft", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ error: "Team archived", code: "team_archived" }, { status: 409 })
    );
    render(<Home />);
    const input = screen.getByPlaceholderText("What do you want to build?");
    await user.type(input, "Ship it");
    await screen.findByText("Team archived (team_archived)");
    await user.clear(input);
    await user.type(input, "Try again");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/sessions")
    ).toHaveLength(1);
  });

  it("can correct visibility after a terminal denial and recreate the draft", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        Response.json({ error: "Visibility denied", code: "visibility_denied" }, { status: 403 })
      )
      .mockResolvedValueOnce(Response.json({ sessionId: "session-1", status: "created" }));
    render(<Home />);
    await user.type(screen.getByPlaceholderText("What do you want to build?"), "Ship it");
    await screen.findByText("Visibility denied (visibility_denied)");
    const visibility = screen.getByRole("button", { name: /^Session access:/ });
    expect(visibility).not.toBeDisabled();
    await selectAudience(user, "Private");
    await waitFor(() => {
      const calls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/sessions");
      expect(calls).toHaveLength(2);
      expect(JSON.parse(String(calls[1][1]?.body))).toMatchObject({
        teamId: null,
        visibility: "private",
      });
    });
  });

  it("waits for a team's default environment before warming the composed draft", async () => {
    const user = userEvent.setup();
    mocks.teams = [team({ defaultEnvironmentId: "env-1" })];
    mocks.activeTeamId = "team-1";
    mocks.environmentsLoadingValue = true;
    localStorage.setItem("open-inspect-last-selected-repo", repo.fullName);
    const view = render(<Home />);
    await user.type(screen.getByPlaceholderText("What do you want to build?"), "Ship it");
    expect(fetch).not.toHaveBeenCalled();
    mocks.environmentsLoadingValue = false;
    mocks.environmentsValue = [environment];
    view.rerender(<Home />);
    await waitFor(() =>
      expect(sessionCreateBody()).toMatchObject({
        environmentId: "env-1",
        teamId: "team-1",
        visibility: "team",
      })
    );
    expect(sessionCreateBody()).not.toHaveProperty("repoOwner");
  });
});
