// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamResponse } from "@/hooks/use-teams";
import { TeamsIndex } from "./teams-index";
import { TeamPage } from "./team-page";

expect.extend(matchers);

const mocks = vi.hoisted(() => ({
  teams: [] as TeamResponse[],
  mine: [] as TeamResponse[],
  role: "member",
  suspendedAt: null as number | null,
  membershipLoading: false,
  membershipError: null as Error | null,
  currentTeam: undefined as TeamResponse | undefined,
  join: vi.fn(),
}));

vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { id: "user_one" } }, status: "authenticated" }),
}));
vi.mock("@/hooks/use-teams", () => ({
  useTeams: () => ({ teams: mocks.teams, loading: false, error: null, joinTeam: mocks.join }),
  useMeTeams: () => ({
    teams: mocks.mine,
    loading: mocks.membershipLoading,
    error: mocks.membershipError,
  }),
  useTeam: (id: string) => ({
    team: mocks.currentTeam ?? mocks.teams.find((team) => team.id === id),
    loading: false,
  }),
  useTeamMembers: () => ({ members: [], loading: false, error: null }),
}));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    authorization: { role: { key: mocks.role }, suspendedAt: mocks.suspendedAt },
  }),
}));
vi.mock("@/components/settings/team-members-table", () => ({
  TeamMembersTable: () => <p>Team member table</p>,
}));
vi.mock("@/components/settings/team-detail", () => ({
  TeamDetail: () => <p>Team settings editor</p>,
}));
vi.mock("./team-overview", () => ({ TeamOverview: () => <p>Team session buckets</p> }));
vi.mock("./team-secrets", () => ({
  TeamSecrets: ({ teamId }: { teamId: string }) => <p>Team secrets editor for {teamId}</p>,
}));
vi.mock("./team-channels", () => ({ TeamChannels: () => <p>Team channel bindings</p> }));

const team: TeamResponse = {
  id: "team_design",
  slug: "design",
  name: "Design",
  description: "Design work",
  joinPolicy: "open",
  defaultVisibility: "team",
  defaultEnvironmentId: null,
  grantsVersion: 0,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  memberCount: 2,
};
const denied = {
  canJoin: false,
  canLeave: false,
  canEditMetadata: false,
  canManageMembers: false,
  canManageRepositories: false,
  canManageBindings: false,
  canManageAutomations: false,
  canManageSecrets: false,
  canArchive: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.teams = [team];
  mocks.mine = [];
  mocks.role = "member";
  mocks.suspendedAt = null;
  mocks.membershipLoading = false;
  mocks.membershipError = null;
  mocks.currentTeam = undefined;
});
afterEach(cleanup);

describe("Teams index", () => {
  it("switches from mine to every active team and searches name, slug, and description", () => {
    mocks.teams = [
      team,
      { ...team, id: "team_engineering", slug: "engineering", name: "Engineering" },
      { ...team, id: "team_archived", slug: "archived", name: "Archived", archivedAt: 2 },
    ];
    mocks.mine = [team];
    render(<TeamsIndex />);
    expect(screen.getByRole("link", { name: "Design" })).toHaveAttribute("href", "/teams/design");
    expect(screen.queryByRole("link", { name: "Engineering" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All teams" }));
    expect(screen.getByRole("link", { name: "Engineering" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Archived" })).not.toBeInTheDocument();
    expect(screen.getAllByText("2 members")).toHaveLength(2);
    expect(screen.getAllByText("Open to join")).toHaveLength(2);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search teams" }), {
      target: { value: "engineering" },
    });
    expect(screen.queryByRole("link", { name: "Design" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Engineering" })).toBeInTheDocument();
  });

  it.each([undefined, denied, { ...denied, canJoin: undefined }])(
    "does not infer Join from open policy when capabilities are %s",
    (capabilities) => {
      mocks.teams = [{ ...team, capabilities }];
      render(<TeamsIndex />);
      fireEvent.click(screen.getByRole("button", { name: "All teams" }));
      expect(screen.queryByRole("button", { name: "Join team" })).not.toBeInTheDocument();
      expect(mocks.join).not.toHaveBeenCalled();
    }
  );

  it("joins only with the server canJoin capability", () => {
    mocks.teams = [{ ...team, capabilities: { ...denied, canJoin: true } }];
    mocks.join.mockResolvedValue(undefined);
    render(<TeamsIndex />);
    fireEvent.click(screen.getByRole("button", { name: "All teams" }));
    fireEvent.click(screen.getByRole("button", { name: "Join team" }));
    expect(mocks.join).toHaveBeenCalledWith(team.id);
  });

  it("persists favorites without changing membership", () => {
    mocks.mine = [team];
    const first = render(<TeamsIndex />);
    fireEvent.click(screen.getByRole("button", { name: "Favorite Design" }));
    expect(screen.getByRole("button", { name: "Unfavorite Design" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    first.unmount();
    render(<TeamsIndex />);
    expect(screen.getByRole("button", { name: "Unfavorite Design" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(mocks.join).not.toHaveBeenCalled();
  });

  it("sorts favorites first and tolerates invalid stored favorites", () => {
    localStorage.setItem("open-inspect-team-favorites:user_one", "{invalid");
    mocks.mine = [team, { ...team, id: "team_alpha", slug: "alpha", name: "Alpha" }];
    render(<TeamsIndex />);
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Alpha",
      "Design",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Favorite Design" }));
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Design",
      "Alpha",
    ]);
  });
});

describe("Team page tabs", () => {
  it("shows the header and Members to a nonmember, even if mutation capabilities are present", () => {
    mocks.teams = [
      {
        ...team,
        capabilities: {
          ...denied,
          canEditMetadata: true,
          canArchive: true,
          canManageSecrets: true,
        },
      },
    ];
    render(<TeamPage slug="design" />);
    expect(screen.getByRole("heading", { name: "Design" })).toBeInTheDocument();
    const tabs = within(screen.getByRole("navigation", { name: "Team tabs" }));
    expect(tabs.getByRole("button", { name: "Members" })).toBeInTheDocument();
    expect(tabs.queryByRole("button", { name: "Overview" })).not.toBeInTheDocument();
    expect(tabs.queryByRole("button", { name: "Channels" })).not.toBeInTheDocument();
    expect(tabs.queryByRole("button", { name: "Activity" })).not.toBeInTheDocument();
    expect(tabs.queryByRole("button", { name: "Secrets" })).not.toBeInTheDocument();
    expect(tabs.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
    expect(screen.getByText("Team member table")).toBeInTheDocument();
    expect(screen.queryByText("Team session buckets")).not.toBeInTheDocument();
  });

  it.each(["member", "administrator", "owner"])("never offers an Activity tab to a %s", (role) => {
    mocks.role = role;
    mocks.mine = role === "member" ? [team] : [];
    render(<TeamPage slug="design" />);
    const tabs = within(screen.getByRole("navigation", { name: "Team tabs" }));
    expect(tabs.getByRole("button", { name: "Overview" })).toBeInTheDocument();
    expect(tabs.getByRole("button", { name: "Members" })).toBeInTheDocument();
    expect(tabs.getByRole("button", { name: "Channels" })).toBeInTheDocument();
    expect(tabs.queryByRole("button", { name: "Activity" })).not.toBeInTheDocument();
  });

  it("shows member Overview and Members but no Settings without capabilities", () => {
    mocks.mine = [team];
    render(<TeamPage slug="design" />);
    expect(screen.getByText("Team session buckets")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Members" }));
    expect(screen.getByText("Team member table")).toBeInTheDocument();
  });

  it.each(["owner", "administrator"])(
    "allows %s Overview but still requires settings capabilities",
    (role) => {
      mocks.role = role;
      const view = render(<TeamPage slug="design" />);
      expect(screen.getByRole("button", { name: "Overview" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Members" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Channels" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
      mocks.teams = [{ ...team, capabilities: { ...denied, canArchive: true } }];
      view.rerender(<TeamPage slug="design" />);
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      expect(screen.getByText("Team settings editor")).toBeInTheDocument();
    }
  );

  it("unmounts Overview when membership disappears", () => {
    mocks.mine = [team];
    const view = render(<TeamPage slug="design" />);
    expect(screen.getByText("Team session buckets")).toBeInTheDocument();
    mocks.mine = [];
    view.rerender(<TeamPage slug="design" />);
    expect(screen.queryByText("Team session buckets")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Overview" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Channels" })).not.toBeInTheDocument();
    expect(screen.getByText("Team member table")).toBeInTheDocument();
  });

  it.each(["loading", "failed"])("withholds private tabs while membership is %s", (state) => {
    mocks.mine = [team];
    mocks.membershipLoading = state === "loading";
    mocks.membershipError = state === "failed" ? new Error("Forbidden") : null;
    render(<TeamPage slug="design" />);
    expect(screen.getByText("Team member table")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Overview" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Channels" })).not.toBeInTheDocument();
  });

  it("unmounts Settings when the server revokes metadata and archive capabilities", () => {
    mocks.mine = [team];
    mocks.teams = [{ ...team, capabilities: { ...denied, canEditMetadata: true } }];
    const view = render(<TeamPage slug="design" />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("Team settings editor")).toBeInTheDocument();
    mocks.currentTeam = { ...team, capabilities: denied };
    view.rerender(<TeamPage slug="design" />);
    expect(screen.queryByText("Team settings editor")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("withholds private content after the current user is suspended", () => {
    mocks.mine = [team];
    mocks.suspendedAt = 1;
    render(<TeamPage slug="design" />);
    expect(screen.queryByText("Team session buckets")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Overview" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Channels" })).not.toBeInTheDocument();
  });

  it("unmounts private content when fresh team metadata reports an archive", () => {
    mocks.mine = [team];
    const view = render(<TeamPage slug="design" />);
    expect(screen.getByText("Team session buckets")).toBeInTheDocument();
    mocks.currentTeam = { ...team, archivedAt: 2 };
    view.rerender(<TeamPage slug="design" />);
    expect(screen.queryByText("Team session buckets")).not.toBeInTheDocument();
    expect(screen.getByText("Team not found.")).toBeInTheDocument();
  });

  it.each(["lead", "owner", "administrator"])(
    "shows Secrets to a %s with the server capability",
    (role) => {
      mocks.role = role === "lead" ? "member" : role;
      mocks.mine = role === "lead" ? [team] : [];
      mocks.teams = [
        {
          ...team,
          capabilities: { ...denied, canManageSecrets: true, canArchive: role === "lead" },
        },
      ];
      render(<TeamPage slug="design" />);

      const tabs = within(screen.getByRole("navigation", { name: "Team tabs" }));
      expect(tabs.getAllByRole("button").map((button) => button.textContent)).toEqual([
        "Overview",
        "Members",
        "Secrets",
        "Channels",
        ...(role === "lead" ? ["Settings"] : []),
      ]);
      if (role === "lead") {
        fireEvent.click(tabs.getByRole("button", { name: "Channels" }));
        expect(screen.getByText("Team channel bindings")).toBeInTheDocument();
      }
      expect(screen.queryByText("Team secrets editor for team_design")).not.toBeInTheDocument();
      fireEvent.click(tabs.getByRole("button", { name: "Secrets" }));
      expect(screen.getByText("Team secrets editor for team_design")).toBeInTheDocument();
    }
  );

  it.each(["member", "owner", "administrator"])(
    "does not infer secret management for a %s with missing capabilities",
    (role) => {
      mocks.role = role;
      mocks.mine = [team];
      render(<TeamPage slug="design" />);

      expect(screen.queryByRole("button", { name: "Secrets" })).not.toBeInTheDocument();
      expect(screen.queryByText("Team secrets editor for team_design")).not.toBeInTheDocument();
    }
  );

  it.each([denied, { canManageSecrets: true }, { ...denied, canManageSecrets: undefined }])(
    "withholds Secrets from a member with denied or incomplete capabilities %s",
    (capabilities) => {
      mocks.mine = [team];
      mocks.teams = [{ ...team, capabilities }];
      render(<TeamPage slug="design" />);

      expect(screen.queryByRole("button", { name: "Secrets" })).not.toBeInTheDocument();
      expect(screen.queryByText("Team secrets editor for team_design")).not.toBeInTheDocument();
    }
  );

  it.each([denied, undefined, { canManageSecrets: true }])(
    "unmounts Secrets when fresh server capabilities become denied, missing, or incomplete: %s",
    (capabilities) => {
      mocks.mine = [team];
      mocks.teams = [{ ...team, capabilities: { ...denied, canManageSecrets: true } }];
      const view = render(<TeamPage slug="design" />);
      fireEvent.click(screen.getByRole("button", { name: "Secrets" }));
      expect(screen.getByText("Team secrets editor for team_design")).toBeInTheDocument();

      mocks.currentTeam = { ...team, capabilities };
      view.rerender(<TeamPage slug="design" />);

      expect(screen.queryByText("Team secrets editor for team_design")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Secrets" })).not.toBeInTheDocument();
      expect(screen.getByText("Team member table")).toBeInTheDocument();
    }
  );

  it.each(["removed", "loading", "failed", "suspended", "archived"])(
    "unmounts Secrets when current membership or team access becomes %s",
    (state) => {
      mocks.mine = [team];
      mocks.teams = [{ ...team, capabilities: { ...denied, canManageSecrets: true } }];
      const view = render(<TeamPage slug="design" />);
      fireEvent.click(screen.getByRole("button", { name: "Secrets" }));
      expect(screen.getByText("Team secrets editor for team_design")).toBeInTheDocument();

      if (state === "removed") mocks.mine = [];
      if (state === "loading") mocks.membershipLoading = true;
      if (state === "failed") mocks.membershipError = new Error("Forbidden");
      if (state === "suspended") mocks.suspendedAt = 1;
      if (state === "archived") mocks.currentTeam = { ...mocks.teams[0], archivedAt: 2 };
      view.rerender(<TeamPage slug="design" />);

      expect(screen.queryByText("Team secrets editor for team_design")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Secrets" })).not.toBeInTheDocument();
    }
  );
});
