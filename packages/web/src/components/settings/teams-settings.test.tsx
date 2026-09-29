// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamMember } from "@/hooks/use-teams";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { TeamsSettings } from "./teams-settings";
import { TeamDetail } from "./team-detail";
import { TeamMembersTable } from "./team-members-table";

expect.extend(matchers);

vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  setMember: vi.fn(),
  hasPermission: false,
  candidates: [] as Array<{
    userId: string;
    displayName: string | null;
    email: string | null;
    suspendedAt: number | null;
  }>,
  teams: [] as Array<{
    id: string;
    slug: string;
    name: string;
    memberCount: number;
    archivedAt: number | null;
  }>,
}));

vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    hasPermission: () => mocks.hasPermission,
  }),
}));
vi.mock("@/hooks/use-teams", () => ({
  useTeams: () => ({ teams: mocks.teams, loading: false, error: null, createTeam: mocks.create }),
  useTeam: () => ({ team: undefined, loading: false, error: null, updateTeam: mocks.update }),
  useTeamMembers: () => ({
    members: [],
    loading: false,
    error: null,
    setMember: mocks.setMember,
    removeMember: mocks.remove,
  }),
  useTeamMemberCandidates: () => ({ candidates: mocks.candidates, loading: false, error: null }),
}));

const team = {
  id: "team_one",
  slug: "one",
  name: "One",
  description: null,
  joinPolicy: "invite_only" as const,
  defaultVisibility: "workspace" as const,
  defaultEnvironmentId: null,
  grantsVersion: 0,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  memberCount: 1,
};
const capabilities = {
  canJoin: false,
  canLeave: false,
  canEditMetadata: true,
  canManageMembers: true,
  canManageRepositories: false,
  canManageBindings: false,
  canManageAutomations: false,
  canManageSecrets: false,
  canArchive: true,
};

const member: TeamMember = {
  teamId: team.id,
  userId: "user_one",
  role: "lead",
  source: "manual",
  createdAt: 1,
  displayName: "Ada",
  email: "ada@example.com",
  avatarUrl: null,
};

function renderTeamsSettings() {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <TeamsSettings />
    </SWRConfig>
  );
}

beforeEach(() => {
  mocks.hasPermission = true;
  mocks.candidates = [];
  mocks.teams = [];
  vi.mocked(browserApiFetch).mockResolvedValue(Response.json({ requireTeamOnCreate: false }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Teams settings", () => {
  it("shows a lead's team with a singular member count", () => {
    mocks.hasPermission = false;
    mocks.teams = [
      { id: team.id, slug: team.slug, name: team.name, memberCount: 1, archivedAt: null },
    ];
    renderTeamsSettings();
    expect(screen.getByText("1 member - Active")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Require a team for new sessions" })).toBeNull();
    expect(browserApiFetch).not.toHaveBeenCalled();
  });

  it("loads and updates the require-team policy for workspace managers", async () => {
    vi.mocked(browserApiFetch).mockResolvedValueOnce(Response.json({ requireTeamOnCreate: false }));
    vi.mocked(browserApiFetch).mockResolvedValueOnce(Response.json({ requireTeamOnCreate: true }));
    renderTeamsSettings();

    const toggle = screen.getByRole("switch", { name: "Require a team for new sessions" });
    expect(toggle).toBeDisabled();
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);

    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(browserApiFetch).toHaveBeenNthCalledWith(1, "/api/settings/teams");
    expect(browserApiFetch).toHaveBeenNthCalledWith(2, "/api/settings/teams", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requireTeamOnCreate: true }),
    });
  });

  it("keeps the stored value and reports a failed policy update", async () => {
    vi.mocked(browserApiFetch).mockResolvedValueOnce(Response.json({ requireTeamOnCreate: true }));
    vi.mocked(browserApiFetch).mockResolvedValueOnce(
      Response.json({ error: "Forbidden" }, { status: 403 })
    );
    renderTeamsSettings();

    const toggle = screen.getByRole("switch", { name: "Require a team for new sessions" });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.getByText("Failed to update team settings")).toBeInTheDocument()
    );
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toBeEnabled();
  });

  it("validates slug and surfaces the slug_taken conflict", async () => {
    mocks.create.mockRejectedValue(new Error("Team slug already exists (slug_taken)"));
    renderTeamsSettings();
    fireEvent.click(screen.getByRole("button", { name: "Create team" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Design" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Slug" }), {
      target: { value: "Bad Slug" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Create$/ }));
    expect(mocks.create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Slug" }), {
      target: { value: "design" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Create$/ }));
    await waitFor(() => expect(screen.getByText(/slug_taken/)).toBeInTheDocument());
  });

  it("disables metadata and lifecycle controls without capabilities", () => {
    render(<TeamDetail team={team} />);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Archive team" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Join policy" })).toBeDisabled();
  });

  it("enables metadata and lifecycle controls with capabilities", () => {
    render(<TeamDetail team={{ ...team, capabilities }} />);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Archive team" })).toBeEnabled();
  });

  it("preserves dirty edits across lifecycle refresh and PATCHes only changed fields", async () => {
    mocks.update.mockResolvedValue({ ...team, name: "Renamed", capabilities });
    const { rerender } = render(<TeamDetail team={{ ...team, capabilities }} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Renamed" },
    });
    rerender(
      <TeamDetail
        team={{
          ...team,
          capabilities,
          archivedAt: 2,
          updatedAt: 2,
          description: "Updated elsewhere",
        }}
      />
    );
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Renamed");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ name: "Renamed" }));
  });

  it("adopts external updates while clean and validates a changed slug", async () => {
    const { rerender } = render(<TeamDetail team={{ ...team, capabilities }} />);
    rerender(<TeamDetail team={{ ...team, name: "New name", updatedAt: 2, capabilities }} />);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("New name")
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Slug" }), {
      target: { value: "Bad Slug" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(mocks.update).not.toHaveBeenCalled();
    expect(screen.getByText(/slug/i, { selector: "div" })).toBeInTheDocument();
  });

  it("does not offer open-team joining from a membership-only settings page", () => {
    render(<TeamDetail team={{ ...team, capabilities: { ...capabilities, canJoin: true } }} />);
    expect(screen.queryByRole("button", { name: "Join team" })).not.toBeInTheDocument();
  });

  it("surfaces last_lead and disables member changes without capabilities", async () => {
    mocks.candidates = [
      {
        userId: "user_two",
        displayName: "Grace",
        email: "grace@example.com",
        suspendedAt: null,
      },
    ];
    const { rerender } = render(
      <TeamMembersTable team={{ ...team, capabilities }} members={[member]} />
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Add member" }), {
      target: { value: "user_two" },
    });
    rerender(<TeamMembersTable team={team} members={[member]} />);
    expect(screen.getByRole("combobox", { name: "Role for Ada" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Ada" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    mocks.remove.mockRejectedValue(new Error("The last team lead cannot be removed (last_lead)"));
    rerender(<TeamMembersTable team={{ ...team, capabilities }} members={[member]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Ada" }));
    await waitFor(() => expect(screen.getByText(/last_lead/)).toBeInTheDocument());
  });

  it("promotes a member to lead from the role select", async () => {
    mocks.setMember.mockResolvedValue(undefined);
    render(
      <TeamMembersTable
        team={{ ...team, capabilities }}
        members={[{ ...member, role: "member" }]}
      />
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Role for Ada" }), {
      target: { value: "lead" },
    });
    await waitFor(() => expect(mocks.setMember).toHaveBeenCalledWith("user_one", "lead"));
  });

  it("adds a selected workspace member with the member role", async () => {
    mocks.candidates = [
      {
        userId: "user_two",
        displayName: "Grace",
        email: "grace@example.com",
        suspendedAt: null,
      },
    ];
    mocks.setMember.mockResolvedValue(undefined);
    render(<TeamMembersTable team={{ ...team, capabilities }} members={[member]} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Add member" }), {
      target: { value: "user_two" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(mocks.setMember).toHaveBeenCalledWith("user_two", "member"));
  });
});
