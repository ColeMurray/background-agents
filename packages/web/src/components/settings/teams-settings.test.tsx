// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamMember } from "@/hooks/use-teams";
import { TeamsSettings } from "./teams-settings";
import { TeamDetail } from "./team-detail";
import { TeamMembersTable } from "./team-members-table";

expect.extend(matchers);

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  setMember: vi.fn(),
  hasPermission: false,
  roleKey: "member" as string,
  allTeams: false,
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
    authorization: { role: { key: mocks.roleKey } },
  }),
}));
vi.mock("@/hooks/use-teams", () => ({
  useTeams: (allTeams: boolean) => {
    mocks.allTeams = allTeams;
    return { teams: mocks.teams, loading: false, error: null, createTeam: mocks.create };
  },
  useTeam: () => ({ team: undefined, loading: false, error: null, updateTeam: mocks.update }),
  useTeamMembers: () => ({
    members: [],
    loading: false,
    error: null,
    setMember: mocks.setMember,
    removeMember: mocks.remove,
  }),
  useTeamMemberCandidates: () => ({ candidates: [], loading: false, error: null }),
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

beforeEach(() => {
  mocks.hasPermission = true;
  mocks.roleKey = "member";
  mocks.teams = [];
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Teams settings", () => {
  it("shows a lead's membership list with a singular count and reserves the all-teams list for admins", () => {
    mocks.hasPermission = false;
    mocks.roleKey = "custom";
    mocks.teams = [
      { id: team.id, slug: team.slug, name: team.name, memberCount: 1, archivedAt: null },
    ];
    const { rerender } = render(<TeamsSettings />);
    expect(mocks.allTeams).toBe(false);
    expect(screen.getByText("1 member - Active")).toBeInTheDocument();
    mocks.roleKey = "administrator";
    rerender(<TeamsSettings />);
    expect(mocks.allTeams).toBe(true);
  });

  it("validates slug and surfaces the slug_taken conflict", async () => {
    mocks.create.mockRejectedValue(new Error("Team slug already exists (slug_taken)"));
    render(<TeamsSettings />);
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

  it("does not offer open-team joining from a membership-only settings page", () => {
    render(<TeamDetail team={{ ...team, capabilities: { ...capabilities, canJoin: true } }} />);
    expect(screen.queryByRole("button", { name: "Join team" })).not.toBeInTheDocument();
  });

  it("surfaces last_lead and disables member changes without capabilities", async () => {
    const { rerender } = render(<TeamMembersTable team={team} members={[member]} />);
    expect(screen.getByRole("combobox", { name: "Role for Ada" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Ada" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    mocks.remove.mockRejectedValue(new Error("The last team lead cannot be removed (last_lead)"));
    rerender(<TeamMembersTable team={{ ...team, capabilities }} members={[member]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Ada" }));
    await waitFor(() => expect(screen.getByText(/last_lead/)).toBeInTheDocument());
  });
});
