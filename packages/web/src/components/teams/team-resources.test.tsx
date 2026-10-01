// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TeamAutomations } from "./team-automations";
import { TeamEnvironments } from "./team-environments";

expect.extend(matchers);
afterEach(cleanup);
const mocks = vi.hoisted(() => ({
  automations: vi.fn(),
  environments: vi.fn(),
  memberships: [{ id: "team/one" }],
  canManageBindings: false,
  canEditMetadata: false,
  canManageEnvironments: true,
}));
vi.mock("@/hooks/use-automations", () => ({
  useAutomations: (search: string, teamId: string) => {
    mocks.automations(search, teamId);
    return { automations: [], loading: false, loadingMore: false, hasMore: false };
  },
}));
vi.mock("@/hooks/use-teams", () => ({
  useTeam: () => ({
    team: {
      capabilities: {
        canManageBindings: mocks.canManageBindings,
        canEditMetadata: mocks.canEditMetadata,
      },
    },
  }),
  useMeTeams: () => ({ teams: mocks.memberships, loading: false, error: null }),
}));
vi.mock("@/hooks/use-team-capabilities", () => ({
  useTeamCapabilities: () => ({
    canManageBindings: mocks.canManageBindings,
    canEditMetadata: mocks.canEditMetadata,
  }),
}));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    hasPermission: (permission: string) =>
      permission === "environments.manage" ? mocks.canManageEnvironments : true,
  }),
}));
vi.mock("@/components/automations/automations-list", () => ({
  AutomationsList: () => <p>Automation rows</p>,
}));
vi.mock("@/components/settings/environments-settings", () => ({
  EnvironmentsSettings: (props: object) => {
    mocks.environments(props);
    return <p>Environment rows</p>;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.memberships = [{ id: "team/one" }];
  mocks.canManageBindings = false;
  mocks.canEditMetadata = false;
  mocks.canManageEnvironments = true;
});

it("loads exact team automations and carries the team into creation", () => {
  render(<TeamAutomations teamId="team/one" />);
  expect(mocks.automations).toHaveBeenCalledWith("", "team/one");
  expect(screen.getByRole("link", { name: "Create Automation" })).toHaveAttribute(
    "href",
    "/automations/new?teamId=team%2Fone"
  );
});

it("does not offer creation for an executor outside the team", () => {
  mocks.memberships = [];
  render(<TeamAutomations teamId="team/one" />);
  expect(screen.queryByRole("link", { name: "Create Automation" })).not.toBeInTheDocument();
});

it("uses metadata capability and workspace environment permission, not binding management, for creation", () => {
  mocks.canManageBindings = true;
  const view = render(<TeamEnvironments teamId="team/one" />);
  expect(mocks.environments).toHaveBeenLastCalledWith({ teamId: "team/one", canCreate: false });
  mocks.canManageBindings = false;
  mocks.canEditMetadata = true;
  view.rerender(<TeamEnvironments teamId="team/one" />);
  expect(mocks.environments).toHaveBeenLastCalledWith({ teamId: "team/one", canCreate: true });
  mocks.canManageEnvironments = false;
  view.rerender(<TeamEnvironments teamId="team/one" />);
  expect(mocks.environments).toHaveBeenLastCalledWith({ teamId: "team/one", canCreate: false });
});
