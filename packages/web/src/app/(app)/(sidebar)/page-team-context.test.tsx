// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

async function selectOption(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  option: string
) {
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
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
  it("defaults workspace drafts to workspace visibility without offering team visibility", async () => {
    const user = userEvent.setup();
    render(<Home />);
    const visibility = screen.getByRole("combobox", { name: "Session visibility" });
    expect(visibility.tagName).toBe("BUTTON");
    expect(visibility).toHaveTextContent("Workspace");
    await user.click(visibility);
    const menu = await screen.findByRole("listbox");
    expect(within(menu).queryByRole("option", { name: "Team" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    fireEvent.change(screen.getByPlaceholderText("What do you want to build?"), {
      target: { value: "Ship it" },
    });
    await waitFor(() =>
      expect(sessionCreateBody()).toMatchObject({ teamId: null, visibility: "workspace" })
    );
  });

  it("uses the active team's defaults and archives the warm draft on visibility and team changes", async () => {
    const user = userEvent.setup();
    mocks.teams = [team(), team({ id: "team-2", name: "Design", defaultVisibility: "private" })];
    mocks.activeTeamId = "team-1";
    const view = render(<Home />);
    fireEvent.change(screen.getByPlaceholderText("What do you want to build?"), {
      target: { value: "Ship it" },
    });
    await waitFor(() =>
      expect(sessionCreateBody()).toMatchObject({ teamId: "team-1", visibility: "team" })
    );
    await selectOption(user, "Session visibility", "Workspace");
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/sessions/session-1/archive", expect.anything())
    );
    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/sessions")
      ).toHaveLength(2)
    );
    mocks.activeTeamId = "team-2";
    view.rerender(<Home />);
    expect(screen.getByRole("combobox", { name: "Session visibility" })).toHaveTextContent(
      "Private"
    );
    await waitFor(() => {
      const calls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/sessions");
      expect(calls).toHaveLength(3);
      expect(JSON.parse(String(calls[2][1]?.body))).toMatchObject({
        teamId: "team-2",
        visibility: "private",
      });
    });
  });

  it("offers a custom composer team choice and maps Workspace back to no team", async () => {
    const user = userEvent.setup();
    mocks.teams = [team()];
    const view = render(<Home />);
    const trigger = screen.getByRole("combobox", { name: "Session team" });
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger).toHaveTextContent("Workspace");
    await selectOption(user, "Session team", "Engineering");
    expect(mocks.setActiveTeam).toHaveBeenCalledWith("team-1");
    mocks.activeTeamId = "team-1";
    view.rerender(<Home />);
    expect(trigger).toHaveTextContent("Engineering");
    await selectOption(user, "Session team", "Workspace");
    expect(mocks.setActiveTeam).toHaveBeenLastCalledWith(null);
  });

  it("selects visibility with the keyboard and restores focus to its trigger", async () => {
    const user = userEvent.setup();
    render(<Home />);
    const trigger = screen.getByRole("combobox", { name: "Session visibility" });
    await user.tab();
    await user.tab();
    expect(trigger).toHaveFocus();
    await user.keyboard("[Space]");
    await waitFor(() => expect(screen.getByRole("option", { name: "Workspace" })).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: "Private" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(trigger).toHaveTextContent("Private");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("waits for membership and settings reconciliation before warming or sending", async () => {
    mocks.teamsLoading = true;
    mocks.teams = [team()];
    const view = render(<Home />);
    const input = screen.getByPlaceholderText("What do you want to build?");
    fireEvent.change(input, { target: { value: "Ship it" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", ctrlKey: true });
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Session team" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Session visibility" })).toBeDisabled();
    expect(fetch).not.toHaveBeenCalled();
    mocks.teamsLoading = false;
    mocks.requireTeamOnCreate = true;
    mocks.teams = [team()];
    view.rerender(<Home />);
    expect(mocks.setActiveTeam).toHaveBeenCalledWith("team-1");
    expect(screen.queryByRole("combobox", { name: "Session team" })).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    mocks.activeTeamId = "team-1";
    view.rerender(<Home />);
    await waitFor(() =>
      expect(sessionCreateBody()).toMatchObject({ teamId: "team-1", visibility: "team" })
    );
  });

  it("blocks warming and shortcut submission with an inline notice when a team is required but none are available", () => {
    mocks.requireTeamOnCreate = true;
    render(<Home />);
    expect(screen.getByText("Join a team to create a session.")).toBeInTheDocument();
    const input = screen.getByPlaceholderText("What do you want to build?");
    fireEvent.change(input, { target: { value: "Ship it" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", ctrlKey: true });
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not create workspace drafts when the team context failed to load", () => {
    mocks.teamsError = new Error("Settings unavailable");
    render(<Home />);
    fireEvent.change(screen.getByPlaceholderText("What do you want to build?"), {
      target: { value: "Ship it" },
    });
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces terminal creation codes on first typing and does not retry the denied draft", async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ error: "Team archived", code: "team_archived" }, { status: 409 })
    );
    render(<Home />);
    const input = screen.getByPlaceholderText("What do you want to build?");
    fireEvent.change(input, { target: { value: "Ship it" } });
    await screen.findByText("Team archived (team_archived)");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.change(input, { target: { value: "Try again" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", ctrlKey: true });
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
    fireEvent.change(screen.getByPlaceholderText("What do you want to build?"), {
      target: { value: "Ship it" },
    });
    await screen.findByText("Visibility denied (visibility_denied)");
    const visibility = screen.getByRole("combobox", { name: "Session visibility" });
    expect(visibility).not.toBeDisabled();
    await selectOption(user, "Session visibility", "Private");
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
    mocks.teams = [team({ defaultEnvironmentId: "env-1" })];
    mocks.activeTeamId = "team-1";
    mocks.environmentsLoadingValue = true;
    localStorage.setItem("open-inspect-last-selected-repo", repo.fullName);
    const view = render(<Home />);
    fireEvent.change(screen.getByPlaceholderText("What do you want to build?"), {
      target: { value: "Ship it" },
    });
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
