// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamMember } from "@/hooks/use-teams";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { TeamsSettings } from "./teams-settings";
import { TeamDetail } from "./team-detail";
import { TeamMembersTable } from "./team-members-table";

expect.extend(matchers);

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = vi.fn();
});

vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  setMember: vi.fn(),
  hasPermission: false,
  viewerId: "user_viewer",
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
vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({
    data: { user: { id: mocks.viewerId } },
    status: "authenticated",
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
  canManageEnvironments: false,
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
  mocks.viewerId = "user_viewer";
  vi.mocked(browserApiFetch).mockResolvedValue(Response.json({ requireTeamOnCreate: false }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Teams settings", () => {
  it.each([
    ["  Grace  ", "person@example.com", "grace", "Grace"],
    ["   ", "person@example.com", "person", "Unnamed user \u00b7 a1b2c3"],
    [null, null, "unnamed", "Unnamed user \u00b7 a1b2c3"],
  ] as const)(
    "uses name, authorized email, or neutral fallback for member typeahead (%s, %s)",
    async (displayName, email, query, name) => {
      mocks.candidates = [
        { userId: "user_ada", displayName: "Ada", email: null, suspendedAt: null },
        { userId: "user_identity_a1b2c3", displayName, email, suspendedAt: null },
      ];
      mocks.setMember.mockResolvedValue(undefined);
      render(<TeamMembersTable team={{ ...team, capabilities }} members={[]} />);
      const user = userEvent.setup();
      const picker = screen.getByRole("combobox", { name: "Add member" });
      await user.click(picker);
      await user.keyboard(query);
      await waitFor(() =>
        expect(screen.getByRole("option", { name: new RegExp(name) })).toHaveFocus()
      );
      await user.keyboard("{Enter}");
      expect(picker).toHaveTextContent(name);
      if (!email) expect(screen.queryByText("person@example.com")).toBeNull();
      await user.click(screen.getByRole("button", { name: "Add" }));
      await waitFor(() =>
        expect(mocks.setMember).toHaveBeenCalledWith("user_identity_a1b2c3", "member")
      );
    }
  );

  it.each([null, "ada@example.com"])(
    "renders member names and avatars with only the returned email (%s)",
    (email) => {
      const { container } = render(
        <TeamMembersTable
          team={team}
          members={[{ ...member, email, avatarUrl: "https://example.com/ada.png" }]}
        />
      );
      expect(screen.getByText("Ada")).toBeInTheDocument();
      expect(container.querySelector('img[src="https://example.com/ada.png"]')).toBeInTheDocument();
      expect(screen.queryByText("ada@example.com")).toBe(email ? screen.getByText(email) : null);
      expect(container.querySelector('[title="ada@example.com"]') !== null).toBe(email !== null);
      expect(screen.queryByText(member.userId)).toBeNull();
    }
  );

  it.each([null, "private@example.com"])(
    "uses a short neutral label rather than email or full ID for an unnamed member (%s)",
    (email) => {
      const userId = "user_long_identity_a1b2c3";
      render(
        <TeamMembersTable team={team} members={[{ ...member, userId, displayName: null, email }]} />
      );
      expect(
        screen.getByRole("combobox", { name: "Role for Unnamed user \u00b7 a1b2c3" })
      ).toBeDisabled();
      expect(screen.getByText("Unnamed user \u00b7 a1b2c3")).toBeInTheDocument();
      expect(screen.queryByText(userId)).toBeNull();
    }
  );

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
    expect(screen.getByRole("combobox", { name: "Default visibility" })).toBeDisabled();
  });

  it("PATCHes join policy and default visibility chosen from the dropdowns", async () => {
    mocks.update.mockResolvedValue({
      ...team,
      joinPolicy: "open",
      defaultVisibility: "private",
      capabilities,
    });
    render(<TeamDetail team={{ ...team, capabilities }} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Join policy" }));
    await user.click(await screen.findByRole("option", { name: "Open" }));
    await user.click(screen.getByRole("combobox", { name: "Default visibility" }));
    await user.click(await screen.findByRole("option", { name: "Private" }));
    expect(screen.getByRole("combobox", { name: "Join policy" })).toHaveTextContent("Open");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({
        joinPolicy: "open",
        defaultVisibility: "private",
      })
    );
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
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Add member" }));
    await user.click(await screen.findByRole("option", { name: /Grace/ }));
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
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Role for Ada" }));
    await user.click(await screen.findByRole("option", { name: "Lead" }));
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
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Add member" }));
    await user.click(await screen.findByRole("option", { name: /Grace/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(mocks.setMember).toHaveBeenCalledWith("user_two", "member"));
  });

  it("lets a member without manage capability leave but not remove others", async () => {
    mocks.remove.mockResolvedValue(undefined);
    mocks.viewerId = "user_two";
    const grace: TeamMember = {
      ...member,
      userId: "user_two",
      role: "member",
      displayName: "Grace",
      email: "grace@example.com",
    };
    render(
      <TeamMembersTable
        team={{
          ...team,
          capabilities: { ...capabilities, canManageMembers: false, canLeave: true },
        }}
        members={[member, grace]}
      />
    );
    expect(screen.getByRole("button", { name: "Remove Ada" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Role for Grace" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove Grace" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("user_two"));
  });

  it("keeps a managing sole lead from removing themselves", () => {
    mocks.viewerId = "user_one";
    const grace: TeamMember = {
      ...member,
      userId: "user_two",
      role: "member",
      displayName: "Grace",
      email: "grace@example.com",
    };
    render(
      <TeamMembersTable
        team={{ ...team, capabilities: { ...capabilities, canLeave: false } }}
        members={[member, grace]}
      />
    );
    expect(screen.getByRole("button", { name: "Remove Ada" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Grace" })).toBeEnabled();
  });
});
