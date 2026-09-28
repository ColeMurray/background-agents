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
}));

vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({ hasPermission: () => mocks.hasPermission }),
}));
vi.mock("@/hooks/use-teams", () => ({
  useTeams: () => ({ teams: [], loading: false, error: null, createTeam: mocks.create }),
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
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Teams settings", () => {
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
