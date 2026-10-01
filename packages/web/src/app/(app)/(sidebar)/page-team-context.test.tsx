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
  it("preselects a required team when the setting changes without widening draft visibility", async () => {
    const user = userEvent.setup();
    mocks.teams = [team()];
    const view = render(<Home />);
    await selectAudience(user, "Private");
    await user.type(screen.getByPlaceholderText("What do you want to build?"), "Ship it");
    await waitFor(() =>
      expect(sessionCreateBody()).toMatchObject({ teamId: null, visibility: "private" })
    );
    mocks.requireTeamOnCreate = true;
    view.rerender(<Home />);
    expect(screen.getByRole("button", { name: /^Session access:/ })).toHaveAccessibleName(
      "Session access: Private; team context: Engineering"
    );
    expect(screen.getByRole("button", { name: /send/i })).not.toBeDisabled();
    expect(mocks.setActiveTeam).not.toHaveBeenCalled();
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/sessions")
    ).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalledWith("/session/session-1"));
    const calls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/sessions");
    expect(JSON.parse(String(calls[1][1]?.body))).toMatchObject({
      teamId: "team-1",
      visibility: "private",
    });
  });

  it("cancels deferred warming when the prompt is cleared before readiness", async () => {
    const user = userEvent.setup();
    mocks.teamsLoading = true;
    const view = render(<Home />);
    const input = screen.getByPlaceholderText("What do you want to build?");
    await user.type(input, "Ship it");
    await user.clear(input);
    mocks.teamsLoading = false;
    view.rerender(<Home />);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["models", "provider accounts"])(
    "consumes deferred input after %s become ready",
    async (resource) => {
      const user = userEvent.setup();
      mocks.enabledModelsLoadingValue = resource === "models";
      mocks.providerAccountsLoadingValue = resource === "provider accounts";
      const view = render(<Home />);
      await user.type(screen.getByPlaceholderText("What do you want to build?"), "Ship it");
      expect(fetch).not.toHaveBeenCalled();
      mocks.enabledModelsLoadingValue = false;
      mocks.providerAccountsLoadingValue = false;
      view.rerender(<Home />);
      await waitFor(() =>
        expect(sessionCreateBody()).toMatchObject({ teamId: null, visibility: "workspace" })
      );
      expect(
        vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/sessions")
      ).toHaveLength(1);
    }
  );

  it.each([
    [undefined, "workspace"],
    [undefined, "all"],
    ["workspace", undefined],
    ["workspace", "all"],
    ["all", undefined],
    ["all", "workspace"],
  ] as const)(
    "reconciles composer access when aggregate scope changes from %s to %s",
    async (from, to) => {
      const user = userEvent.setup();
      mocks.teams = [team()];
      mocks.scope = from;
      const view = render(<Home />);
      await user.click(screen.getByRole("button", { name: /^Session access:/ }));
      await selectTeam(user, "Engineering");
      await user.keyboard("{Escape}");
      await selectAudience(user, "Private");
      await user.type(screen.getByPlaceholderText("What do you want to build?"), "Ship it");
      await waitFor(() =>
        expect(sessionCreateBody()).toMatchObject({ teamId: "team-1", visibility: "private" })
      );

      mocks.scope = to;
      view.rerender(<Home />);
      expect(screen.getByRole("button", { name: /^Session access:/ })).toHaveAccessibleName(
        "Session access: Workspace; team context: No team"
      );
      await waitFor(() =>
        expect(fetch).toHaveBeenCalledWith("/api/sessions/session-1/archive", expect.anything())
      );
      expect(
        vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/sessions")
      ).toHaveLength(1);
      mocks.scope = from;
      view.rerender(<Home />);
      expect(screen.getByRole("button", { name: /^Session access:/ })).toHaveAccessibleName(
        "Session access: Workspace; team context: No team"
      );
      await user.click(screen.getByRole("button", { name: /send/i }));
      await waitFor(() => expect(mocks.routerPush).toHaveBeenCalledWith("/session/session-1"));
      const calls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/sessions");
      expect(calls).toHaveLength(2);
      expect(JSON.parse(String(calls[1][1]?.body))).toMatchObject({
        teamId: null,
        visibility: "workspace",
      });
      expect(mocks.setActiveTeam).not.toHaveBeenCalled();
    }
  );

  it("re-warms a retired draft on continued input without duplicating session creation", async () => {
    const user = userEvent.setup();
    render(<Home />);
    const input = screen.getByPlaceholderText("What do you want to build?");
    await user.type(input, "Ship it");
    await waitFor(() => expect(sessionCreateBody()).toBeDefined());
    await selectAudience(user, "Private");
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/sessions/session-1/archive", expect.anything())
    );
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/sessions")
    ).toHaveLength(1);
    await user.type(input, " again");
    await waitFor(() => {
      const calls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/sessions");
      expect(calls).toHaveLength(2);
      expect(JSON.parse(String(calls[1][1]?.body))).toMatchObject({ visibility: "private" });
    });
  });

  it("consumes deferred warming once memberships become ready without further input", async () => {
    const user = userEvent.setup();
    mocks.teamsLoading = true;
    mocks.teams = [team()];
    mocks.requireTeamOnCreate = true;
    const view = render(<Home />);
    const input = screen.getByPlaceholderText("What do you want to build?");
    await user.type(input, "Ship it");
    expect(fetch).not.toHaveBeenCalled();
    mocks.teamsLoading = false;
    view.rerender(<Home />);
    await waitFor(() =>
      expect(sessionCreateBody()).toMatchObject({ teamId: "team-1", visibility: "team" })
    );
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/sessions")
    ).toHaveLength(1);
  });

  it("preselects the first required team locally without changing All my teams", async () => {
    mocks.teams = [team()];
    mocks.requireTeamOnCreate = true;
    const user = userEvent.setup();
    render(<Home />);
    expect(screen.getByRole("button", { name: /^Session access:/ })).toHaveAccessibleName(
      "Session access: Engineering team; team context: Engineering"
    );
    expect(mocks.activeTeamId).toBeNull();
    expect(mocks.setActiveTeam).not.toHaveBeenCalled();
    await user.type(screen.getByPlaceholderText("What do you want to build?"), "Ship it");
    await waitFor(() =>
      expect(sessionCreateBody()).toMatchObject({ teamId: "team-1", visibility: "team" })
    );
  });

  it("archives a draft on model change without creating its replacement until submit", async () => {
    mocks.enabledModelsValue.push("openai/gpt-5.4");
    mocks.enabledModelOptionsValue.push({
      category: "OpenAI",
      models: [
        {
          id: "openai/gpt-5.4",
          name: "GPT-5.4",
          description: "",
        },
      ],
    });
    const user = userEvent.setup();
    render(<Home />);
    await user.type(screen.getByPlaceholderText("What do you want to build?"), "Ship it");
    await waitFor(() => expect(sessionCreateBody()).toBeDefined());
    await user.click(screen.getByRole("button", { name: "Switch model to GPT-5.4" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/sessions/session-1/archive", expect.anything())
    );
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/sessions")
    ).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalledWith("/session/session-1"));
    const calls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/sessions");
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[1][1]?.body))).toMatchObject({ model: "openai/gpt-5.4" });
  });

  it("falls back locally when the composer's team is no longer an active membership", async () => {
    const user = userEvent.setup();
    mocks.teams = [team()];
    const view = render(<Home />);
    await user.click(screen.getByRole("button", { name: /^Session access:/ }));
    await selectTeam(user, "Engineering");
    await user.keyboard("{Escape}");
    await selectAudience(user, "Engineering team");
    mocks.teams = [];
    view.rerender(<Home />);
    expect(screen.getByRole("button", { name: /^Session access:/ })).toHaveAccessibleName(
      "Session access: Workspace; team context: No team"
    );
    expect(mocks.setActiveTeam).not.toHaveBeenCalled();
    await user.type(screen.getByPlaceholderText("What do you want to build?"), "Ship it");
    await waitFor(() =>
      expect(sessionCreateBody()).toMatchObject({ teamId: null, visibility: "workspace" })
    );
  });

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
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/sessions")
    ).toHaveLength(1);
    await user.clear(screen.getByPlaceholderText("What do you want to build?"));
    await user.type(screen.getByPlaceholderText("What do you want to build?"), "Ship it");
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
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/sessions")
    ).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: /send/i }));
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
    render(<Home />);
    const trigger = screen.getByRole("button", { name: /^Session access:/ });
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger).toHaveTextContent("Workspace");
    await user.click(trigger);
    await selectTeam(user, "Engineering");
    expect(mocks.setActiveTeam).not.toHaveBeenCalled();
    expect(mocks.activeTeamId).toBeNull();
    expect(trigger).toHaveAccessibleName("Session access: Workspace; team context: Engineering");
    expect(screen.getByRole("combobox", { name: "Team context" })).toHaveTextContent("Engineering");
    await selectTeam(user, "No team");
    expect(mocks.setActiveTeam).not.toHaveBeenCalled();
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
    render(<Home />);
    await selectAudience(user, "Private");
    await user.type(screen.getByPlaceholderText("What do you want to build?"), "Ship it");
    await waitFor(() =>
      expect(sessionCreateBody()).toMatchObject({ teamId: "team-1", visibility: "private" })
    );
    await user.click(screen.getByRole("button", { name: /^Session access:/ }));
    await selectTeam(user, "Design");
    expect(mocks.setActiveTeam).not.toHaveBeenCalled();
    expect(mocks.activeTeamId).toBe("team-1");
    expect(
      screen.getByRole("button", { name: "Session access: Private; team context: Design" })
    ).toHaveTextContent("Private");
    expect(screen.getByRole("radio", { name: "Private" })).toBeChecked();
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/sessions")
    ).toHaveLength(1);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: /send/i }));
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
    await waitFor(() =>
      expect(sessionCreateBody()).toMatchObject({ teamId: "team-1", visibility: "team" })
    );
    expect(mocks.setActiveTeam).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /^Session access:/ }));
    expect(screen.getByRole("combobox", { name: "Team context" })).not.toBeDisabled();
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).not.toBeDisabled();
    }
    await user.click(screen.getByRole("combobox", { name: "Team context" }));
    expect(screen.queryByRole("option", { name: "No team" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}{Escape}");
    await user.click(screen.getByRole("button", { name: /send/i }));
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
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/sessions")
    ).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => {
      const calls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/sessions");
      expect(calls).toHaveLength(2);
      expect(JSON.parse(String(calls[1][1]?.body))).toMatchObject({
        teamId: null,
        visibility: "private",
      });
    });
  });

  it("consumes deferred warming after a team's default environment becomes ready", async () => {
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
