// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig, unstable_serialize } from "swr";
import { TEAMS_KEY, teamCacheKey } from "@/hooks/use-teams";
import type { TeamResponse } from "@/hooks/use-teams";
import { TeamsIndex } from "./teams-index";
import { TeamPage } from "./team-page";

expect.extend(matchers);

const mocks = vi.hoisted(() => ({
  teams: [] as TeamResponse[],
  mine: [] as TeamResponse[],
  role: "member",
  permissions: ["automations.read"],
  suspendedAt: null as number | null,
  membershipLoading: false,
  membershipError: null as Error | null,
  currentTeam: undefined as TeamResponse | undefined,
  join: vi.fn(),
  repositories: vi.fn(),
  secrets: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { id: "user_one" } }, status: "authenticated" }),
}));
vi.mock("@/hooks/use-teams", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTeams: () => ({ teams: mocks.teams, loading: false, error: null, joinTeam: mocks.join }),
  useMeTeams: () => ({
    teams: mocks.mine,
    canListAllTeams: false,
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
    hasPermission: (permission: string) => mocks.permissions.includes(permission),
  }),
}));
vi.mock("@/components/settings/team-members-table", () => ({
  TeamMembersTable: () => <p>Team member table</p>,
}));
vi.mock("@/components/settings/team-detail", () => ({
  TeamDetail: () => <p>Team settings editor</p>,
}));
vi.mock("./team-overview", () => ({ TeamOverview: () => <p>Team session buckets</p> }));
vi.mock("./team-repositories", () => ({
  TeamRepositories: (props: { team: TeamResponse }) => {
    mocks.repositories(props);
    return <p>Team repository grants</p>;
  },
}));
vi.mock("./team-environments", () => ({
  TeamEnvironments: ({ teamId }: { teamId: string }) => <p>Environments for {teamId}</p>,
}));
vi.mock("./team-automations", () => ({
  TeamAutomations: ({ teamId }: { teamId: string }) => <p>Automations for {teamId}</p>,
}));
vi.mock("./team-secrets", () => ({
  TeamSecrets: (props: { teamId: string; capabilities?: TeamResponse["capabilities"] }) => {
    mocks.secrets(props);
    return <p>Team secrets editor for {props.teamId}</p>;
  },
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
  canReadTeamSessions: false,
  canReadTeamRepositories: false,
  canReadTeamEnvironments: false,
  canReadAutomations: false,
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
const readable = {
  ...denied,
  canReadTeamSessions: true,
  canReadTeamRepositories: true,
  canReadTeamEnvironments: true,
  canReadAutomations: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.teams = [team];
  mocks.mine = [];
  mocks.role = "member";
  mocks.permissions = ["automations.read"];
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
  it("does not populate an absent directory when reconciling a canonical slug", async () => {
    const cache = new Map();
    mocks.currentTeam = { ...team, slug: "product-design" };
    render(
      <SWRConfig value={{ provider: () => cache }}>
        <TeamPage slug="design" />
      </SWRConfig>
    );
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/teams/product-design"));
    expect(
      cache.get(unstable_serialize(teamCacheKey(TEAMS_KEY, "user_one")))?.data
    ).toBeUndefined();
  });

  it("follows navigation to a different active team", () => {
    mocks.teams = [
      team,
      { ...team, id: "team_engineering", slug: "engineering", name: "Engineering" },
    ];
    const view = render(<TeamPage slug="design" />);
    expect(screen.getByRole("heading", { name: "Design" })).toBeInTheDocument();

    view.rerender(<TeamPage slug="engineering" />);

    expect(screen.getByRole("heading", { name: "Engineering" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Design" })).not.toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it.each(["missing", "archived"])(
    "does not retain a team when navigating to the %s slug",
    (slug) => {
      mocks.teams = [team, { ...team, id: "team_archived", slug: "archived", archivedAt: 2 }];
      const view = render(<TeamPage slug="design" />);
      expect(screen.getByRole("heading", { name: "Design" })).toBeInTheDocument();

      view.rerender(<TeamPage slug={slug} />);

      expect(screen.getByText("Team not found.")).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Design" })).not.toBeInTheDocument();
      expect(mocks.replace).not.toHaveBeenCalled();

      mocks.teams = [
        { ...team, slug: "product-design" },
        { ...team, id: "team_reused", name: "New Design Team" },
      ];
      view.rerender(<TeamPage slug="design" />);
      expect(screen.getByRole("heading", { name: "New Design Team" })).toBeInTheDocument();
      expect(mocks.replace).not.toHaveBeenCalled();
    }
  );

  it.each(["member", "administrator", "owner"])(
    "shows mutation-granted tabs independently of denied resource reads for a %s",
    (role) => {
      mocks.role = role;
      mocks.mine = [team];
      mocks.teams = [
        {
          ...team,
          capabilities: {
            ...denied,
            canEditMetadata: true,
            canArchive: true,
            canManageSecrets: true,
            canManageBindings: true,
          },
        },
      ];
      render(<TeamPage slug="design" />);
      expect(screen.getByRole("heading", { name: "Design" })).toBeInTheDocument();
      const tabs = within(screen.getByRole("navigation", { name: "Team tabs" }));
      expect(tabs.getByRole("button", { name: "Members" })).toBeInTheDocument();
      expect(tabs.queryByRole("button", { name: "Overview" })).not.toBeInTheDocument();
      expect(tabs.getByRole("button", { name: "Channels" })).toBeInTheDocument();
      expect(tabs.queryByRole("button", { name: "Activity" })).not.toBeInTheDocument();
      expect(tabs.queryByRole("button", { name: "Repositories" })).not.toBeInTheDocument();
      expect(tabs.getByRole("button", { name: "Secrets" })).toBeInTheDocument();
      expect(tabs.queryByRole("button", { name: "Environments" })).not.toBeInTheDocument();
      expect(tabs.queryByRole("button", { name: "Automations" })).not.toBeInTheDocument();
      expect(tabs.getByRole("button", { name: "Settings" })).toBeInTheDocument();
      expect(screen.getByText("Team member table")).toBeInTheDocument();
      expect(screen.queryByText("Team session buckets")).not.toBeInTheDocument();
    }
  );

  it.each(["member", "administrator", "owner"])("never offers an Activity tab to a %s", (role) => {
    mocks.role = role;
    mocks.mine = role === "member" ? [team] : [];
    mocks.teams = [{ ...team, capabilities: readable }];
    render(<TeamPage slug="design" />);
    const tabs = within(screen.getByRole("navigation", { name: "Team tabs" }));
    expect(tabs.getByRole("button", { name: "Overview" })).toBeInTheDocument();
    expect(tabs.getByRole("button", { name: "Members" })).toBeInTheDocument();
    expect(tabs.queryByRole("button", { name: "Channels" })).not.toBeInTheDocument();
    expect(tabs.queryByRole("button", { name: "Activity" })).not.toBeInTheDocument();
  });

  it("shows server-granted work to a nonmember without raw permissions or mutation grants", () => {
    mocks.permissions = [];
    mocks.teams = [{ ...team, capabilities: readable }];
    render(<TeamPage slug="design" />);
    expect(screen.getByText("Team session buckets")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Repositories" }));
    expect(screen.getByText("Team repository grants")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Members" }));
    expect(screen.getByText("Team member table")).toBeInTheDocument();
  });

  it("mounts scoped resources and unmounts them when fresh work capabilities are revoked", () => {
    mocks.mine = [team];
    mocks.teams = [
      { ...team, capabilities: { ...readable, canEditMetadata: true, canManageSecrets: true } },
    ];
    const view = render(<TeamPage slug="design" />);
    const tabs = within(screen.getByRole("navigation", { name: "Team tabs" }));
    fireEvent.click(tabs.getByRole("button", { name: "Environments" }));
    expect(screen.getByText("Environments for team_design")).toBeInTheDocument();
    fireEvent.click(tabs.getByRole("button", { name: "Automations" }));
    expect(screen.getByText("Automations for team_design")).toBeInTheDocument();
    mocks.currentTeam = {
      ...mocks.teams[0],
      capabilities: { ...readable, canReadTeamEnvironments: false, canReadAutomations: false },
    };
    view.rerender(<TeamPage slug="design" />);
    expect(screen.queryByText("Automations for team_design")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Automations" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Environments" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Overview" })).toBeInTheDocument();
  });

  it("hides the Automations tab when server-denied even with automations.read", () => {
    mocks.mine = [team];
    mocks.teams = [{ ...team, capabilities: { ...readable, canReadAutomations: false } }];
    render(<TeamPage slug="design" />);
    const tabs = within(screen.getByRole("navigation", { name: "Team tabs" }));
    expect(tabs.getByRole("button", { name: "Environments" })).toBeInTheDocument();
    expect(tabs.queryByRole("button", { name: "Automations" })).not.toBeInTheDocument();
  });

  it.each(["owner", "administrator"])(
    "allows server-granted %s Overview but still requires settings capabilities",
    (role) => {
      mocks.role = role;
      mocks.teams = [{ ...team, capabilities: readable }];
      const view = render(<TeamPage slug="design" />);
      expect(screen.getByRole("button", { name: "Overview" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Members" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Repositories" }));
      expect(screen.getByText("Team repository grants")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
      mocks.teams = [{ ...team, capabilities: { ...readable, canArchive: true } }];
      view.rerender(<TeamPage slug="design" />);
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      expect(screen.getByText("Team settings editor")).toBeInTheDocument();
    }
  );

  it("passes fresh server repository capabilities to the repository tab", () => {
    mocks.mine = [team];
    mocks.teams = [{ ...team, capabilities: { ...readable, canManageRepositories: true } }];
    const view = render(<TeamPage slug="design" />);
    fireEvent.click(screen.getByRole("button", { name: "Repositories" }));
    expect(mocks.repositories).toHaveBeenLastCalledWith({ team: mocks.teams[0] });
    mocks.currentTeam = { ...team, capabilities: readable };
    view.rerender(<TeamPage slug="design" />);
    expect(mocks.repositories).toHaveBeenLastCalledWith({ team: mocks.currentTeam });
    expect(screen.getByText("Team repository grants")).toBeInTheDocument();
  });

  it.each([
    ["canReadTeamSessions", "Overview", "Team session buckets", false],
    ["canReadTeamSessions", "Overview", "Team session buckets", undefined],
    ["canReadTeamRepositories", "Repositories", "Team repository grants", false],
    ["canReadTeamRepositories", "Repositories", "Team repository grants", undefined],
    ["canReadTeamEnvironments", "Environments", "Environments for team_design", false],
    ["canReadTeamEnvironments", "Environments", "Environments for team_design", undefined],
  ] as const)(
    "revokes %s for %s (%s) when its fresh grant becomes %s",
    (grant, tab, content, value) => {
      mocks.mine = [team];
      mocks.teams = [{ ...team, capabilities: readable }];
      const view = render(<TeamPage slug="design" />);
      fireEvent.click(screen.getByRole("button", { name: tab }));
      expect(screen.getByText(content)).toBeInTheDocument();
      mocks.currentTeam = { ...team, capabilities: { ...readable, [grant]: value } };
      view.rerender(<TeamPage slug="design" />);
      expect(screen.queryByText(content)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: tab })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Automations" })).toBeInTheDocument();
      expect(screen.getByText("Team member table")).toBeInTheDocument();
    }
  );

  it.each(["loading", "failed"])(
    "uses fresh server grants independently of %s membership lookup",
    (state) => {
      mocks.mine = [team];
      mocks.membershipLoading = state === "loading";
      mocks.membershipError = state === "failed" ? new Error("Forbidden") : null;
      mocks.teams = [{ ...team, capabilities: readable }];
      render(<TeamPage slug="design" />);
      expect(screen.getByText("Team session buckets")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Overview" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Channels" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Repositories" })).toBeInTheDocument();
    }
  );

  it("unmounts Settings when the server revokes metadata and archive capabilities", () => {
    mocks.mine = [team];
    mocks.teams = [{ ...team, capabilities: { ...readable, canEditMetadata: true } }];
    const view = render(<TeamPage slug="design" />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("Team settings editor")).toBeInTheDocument();
    mocks.currentTeam = { ...team, capabilities: readable };
    view.rerender(<TeamPage slug="design" />);
    expect(screen.queryByText("Team settings editor")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("withholds private content when the server denies a suspended user", () => {
    mocks.mine = [team];
    mocks.suspendedAt = 1;
    mocks.teams = [{ ...team, capabilities: denied }];
    render(<TeamPage slug="design" />);
    expect(screen.queryByText("Team session buckets")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Overview" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Channels" })).not.toBeInTheDocument();
  });

  it("unmounts private content when fresh team metadata reports an archive", () => {
    mocks.mine = [team];
    mocks.teams = [{ ...team, capabilities: readable }];
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
          capabilities: {
            ...readable,
            canManageSecrets: true,
            canManageBindings: role === "lead",
            canArchive: role === "lead",
          },
        },
      ];
      render(<TeamPage slug="design" />);

      const tabs = within(screen.getByRole("navigation", { name: "Team tabs" }));
      expect(tabs.getAllByRole("button").map((button) => button.textContent)).toEqual([
        "Overview",
        "Members",
        "Repositories",
        "Environments",
        "Automations",
        "Secrets",
        ...(role === "lead" ? ["Channels"] : []),
        ...(role === "lead" ? ["Settings"] : []),
      ]);
      if (role === "lead") {
        fireEvent.click(tabs.getByRole("button", { name: "Channels" }));
        expect(screen.getByText("Team channel bindings")).toBeInTheDocument();
      }
      expect(screen.queryByText("Team secrets editor for team_design")).not.toBeInTheDocument();
      fireEvent.click(tabs.getByRole("button", { name: "Secrets" }));
      expect(screen.getByText("Team secrets editor for team_design")).toBeInTheDocument();
      expect(mocks.secrets).toHaveBeenLastCalledWith({
        teamId: team.id,
        capabilities: mocks.teams[0].capabilities,
      });
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

  it.each([readable, { canManageSecrets: true }, { ...readable, canManageSecrets: undefined }])(
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
      mocks.teams = [{ ...team, capabilities: { ...readable, canManageSecrets: true } }];
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
    "unmounts Secrets when fresh server access is revoked after membership or team access becomes %s",
    (state) => {
      mocks.mine = [team];
      mocks.teams = [{ ...team, capabilities: { ...readable, canManageSecrets: true } }];
      const view = render(<TeamPage slug="design" />);
      fireEvent.click(screen.getByRole("button", { name: "Secrets" }));
      expect(screen.getByText("Team secrets editor for team_design")).toBeInTheDocument();

      if (state === "removed") mocks.mine = [];
      if (state === "loading") mocks.membershipLoading = true;
      if (state === "failed") mocks.membershipError = new Error("Forbidden");
      if (state === "suspended") mocks.suspendedAt = 1;
      mocks.currentTeam = {
        ...mocks.teams[0],
        capabilities: { ...mocks.teams[0].capabilities, canManageSecrets: false },
        ...(state === "archived" ? { archivedAt: 2 } : {}),
      };
      view.rerender(<TeamPage slug="design" />);

      expect(screen.queryByText("Team secrets editor for team_design")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Secrets" })).not.toBeInTheDocument();
    }
  );

  it.each([
    undefined,
    { ...denied, canReadTeamSessions: undefined },
    { canReadTeamSessions: true, canReadAutomations: true },
  ])("fails closed for missing or incomplete work capabilities %j", (capabilities) => {
    mocks.role = "owner";
    mocks.mine = [team];
    mocks.teams = [{ ...team, capabilities }];
    render(<TeamPage slug="design" />);
    expect(screen.getByText("Team member table")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Overview" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Automations" })).not.toBeInTheDocument();
  });

  it.each([
    ["canReadTeamSessions", "Overview", "Team session buckets"],
    ["canReadTeamRepositories", "Repositories", "Team repository grants"],
    ["canReadTeamEnvironments", "Environments", "Environments for team_design"],
    ["canReadAutomations", "Automations", "Automations for team_design"],
    ["canManageBindings", "Channels", "Team channel bindings"],
    ["canManageSecrets", "Secrets", "Team secrets editor for team_design"],
    ["canEditMetadata", "Settings", "Team settings editor"],
    ["canArchive", "Settings", "Team settings editor"],
  ] as const)(
    "uses only %s to grant %s, without other grants from ownership or membership",
    (grant, tab, content) => {
      mocks.role = "owner";
      mocks.mine = [team];
      mocks.permissions = [
        "sessions.read",
        "repositories.read",
        "environments.read",
        "automations.read",
      ];
      mocks.teams = [{ ...team, capabilities: { ...denied, [grant]: true } }];
      render(<TeamPage slug="design" />);
      const tabs = within(screen.getByRole("navigation", { name: "Team tabs" }));
      expect(tabs.getAllByRole("button").map((button) => button.textContent)).toEqual(
        tab === "Overview" ? ["Overview", "Members"] : ["Members", tab]
      );
      fireEvent.click(tabs.getByRole("button", { name: tab }));
      expect(screen.getByText(content)).toBeInTheDocument();
    }
  );

  it.each([
    ["canReadTeamSessions", "Overview"],
    ["canReadTeamRepositories", "Repositories"],
    ["canReadTeamEnvironments", "Environments"],
    ["canReadAutomations", "Automations"],
  ] as const)("defaults missing %s to false without revoking other tabs", (grant, tab) => {
    mocks.role = "owner";
    mocks.mine = [team];
    mocks.teams = [
      {
        ...team,
        capabilities: {
          ...readable,
          canManageBindings: true,
          canManageSecrets: true,
          canEditMetadata: true,
          [grant]: undefined,
        },
      },
    ];
    render(<TeamPage slug="design" />);
    const tabs = within(screen.getByRole("navigation", { name: "Team tabs" }));
    expect(tabs.getAllByRole("button").map((button) => button.textContent)).toEqual(
      [
        "Overview",
        "Members",
        "Repositories",
        "Environments",
        "Automations",
        "Secrets",
        "Channels",
        "Settings",
      ].filter((name) => name !== tab)
    );
  });

  it("does not infer sessions or environment reads for a custom-role team member", () => {
    mocks.role = "custom";
    mocks.mine = [team];
    mocks.permissions = ["repositories.read", "automations.read"];
    mocks.teams = [
      {
        ...team,
        capabilities: {
          ...readable,
          canReadTeamSessions: undefined,
          canReadTeamEnvironments: undefined,
        },
      },
    ];
    render(<TeamPage slug="design" />);
    const tabs = within(screen.getByRole("navigation", { name: "Team tabs" }));
    expect(tabs.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Members",
      "Repositories",
      "Automations",
    ]);
    expect(screen.getByText("Team member table")).toBeInTheDocument();
  });

  it.each([false, undefined])(
    "unmounts Automations when fresh canReadAutomations becomes %s",
    (canReadAutomations) => {
      mocks.permissions = [];
      mocks.teams = [{ ...team, capabilities: readable }];
      const view = render(<TeamPage slug="design" />);
      fireEvent.click(screen.getByRole("button", { name: "Automations" }));
      expect(screen.getByText("Automations for team_design")).toBeInTheDocument();
      mocks.currentTeam = { ...team, capabilities: { ...readable, canReadAutomations } };
      view.rerender(<TeamPage slug="design" />);
      expect(screen.queryByText("Automations for team_design")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Automations" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Overview" })).toBeInTheDocument();
    }
  );
});
