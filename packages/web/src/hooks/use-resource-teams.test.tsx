// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useResourceTeams } from "./use-resource-teams";

const mocks = vi.hoisted(() => ({
  teams: [] as Array<{
    id: string;
    name: string;
    archivedAt: number | null;
    capabilities?: {
      canManageAutomations?: boolean;
      canManageBindings?: boolean;
      canManageEnvironments?: boolean;
      canEditMetadata?: boolean;
    };
  }>,
  memberships: [] as Array<{ id: string; name: string; archivedAt: number | null }>,
  directory: { loading: false, error: null as Error | null },
  membership: { loading: false, error: null as Error | null },
  requireTeamOnCreate: false,
}));
vi.mock("./use-teams", () => ({
  useTeams: () => ({ teams: mocks.teams, ...mocks.directory }),
  useMeTeams: () => ({
    teams: mocks.memberships,
    ...mocks.membership,
    requireTeamOnCreate: mocks.requireTeamOnCreate,
  }),
}));

beforeEach(() => {
  mocks.directory = { loading: false, error: null };
  mocks.membership = { loading: false, error: null };
  mocks.requireTeamOnCreate = false;
  mocks.teams = [
    { id: "mine", name: "Mine", archivedAt: null },
    { id: "open", name: "Open", archivedAt: null },
    {
      id: "managed",
      name: "Managed",
      archivedAt: null,
      capabilities: {
        canManageAutomations: true,
        canManageBindings: false,
        canManageEnvironments: true,
      },
    },
    {
      id: "archived",
      name: "Archived",
      archivedAt: 1,
      capabilities: {
        canManageAutomations: true,
        canManageBindings: true,
        canManageEnvironments: true,
      },
    },
    {
      id: "bindings-only",
      name: "Bindings only",
      archivedAt: null,
      capabilities: {
        canManageBindings: true,
        canEditMetadata: true,
        canManageEnvironments: false,
      },
    },
  ];
  mocks.memberships = [mocks.teams[0], mocks.teams[3]];
});

it("offers only automation creation memberships, not merely visible or administrable teams", () => {
  const { result } = renderHook(() => useResourceTeams("automation"));
  expect(result.current.teams.map((team) => team.id)).toEqual(["mine"]);
});

it("requires the environment capability, not metadata or binding management, for creation", () => {
  const { result } = renderHook(() => useResourceTeams("environment"));
  expect(result.current.teams.map((team) => team.id)).toEqual(["managed"]);
});

it.each([false, true])("respects requireTeamOnCreate=%s", (required) => {
  mocks.requireTeamOnCreate = required;
  const creation = renderHook(() => useResourceTeams("automation"));
  expect(creation.result.current.allowWorkspace).toBe(!required);
});

it.each([
  ["directory", "loading"],
  ["directory", "error"],
  ["membership", "loading"],
  ["membership", "error"],
] as const)("withholds choices when %s context is %s", (source, state) => {
  mocks[source].loading = state === "loading";
  mocks[source].error = state === "error" ? new Error("Forbidden") : null;
  const { result } = renderHook(() => useResourceTeams("automation"));
  expect(result.current.teams).toEqual([]);
});
