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
      canEditMetadata?: boolean;
    };
  }>,
  memberships: [] as Array<{ id: string; name: string; archivedAt: number | null }>,
  error: null as Error | null,
  loading: false,
  requireTeamOnCreate: false,
}));
vi.mock("./use-teams", () => ({
  useTeams: () => ({ teams: mocks.teams, loading: mocks.loading, error: mocks.error }),
  useMeTeams: () => ({
    teams: mocks.memberships,
    loading: mocks.loading,
    error: mocks.error,
    requireTeamOnCreate: mocks.requireTeamOnCreate,
  }),
}));

beforeEach(() => {
  mocks.error = null;
  mocks.loading = false;
  mocks.requireTeamOnCreate = false;
  mocks.teams = [
    { id: "mine", name: "Mine", archivedAt: null },
    { id: "open", name: "Open", archivedAt: null },
    {
      id: "managed",
      name: "Managed",
      archivedAt: null,
      capabilities: { canManageAutomations: true, canManageBindings: false, canEditMetadata: true },
    },
    {
      id: "archived",
      name: "Archived",
      archivedAt: 1,
      capabilities: { canManageAutomations: true, canManageBindings: true, canEditMetadata: true },
    },
  ];
  mocks.memberships = [mocks.teams[0]];
});

it("offers only automation creation memberships, not merely visible or administrable teams", () => {
  const { result } = renderHook(() => useResourceTeams("automation"));
  expect(result.current.teams.map((team) => team.id)).toEqual(["mine"]);
});

it("requires server management capability for environment creation", () => {
  const { result } = renderHook(() => useResourceTeams("environment"));
  expect(result.current.teams.map((team) => team.id)).toEqual(["managed"]);
});

it("does not use binding management for environment creation choices", () => {
  mocks.teams.push({
    id: "bindings-only",
    name: "Bindings only",
    archivedAt: null,
    capabilities: { canManageBindings: true, canEditMetadata: false },
  });
  const { result } = renderHook(() => useResourceTeams("environment"));
  expect(result.current.teams.map((team) => team.id)).toEqual(["managed"]);
});

it("respects required-team creation", () => {
  mocks.requireTeamOnCreate = true;
  const creation = renderHook(() => useResourceTeams("automation"));
  expect(creation.result.current.allowWorkspace).toBe(false);
});

it.each(["loading", "error"])("withholds choices when team context is %s", (state) => {
  mocks.loading = state === "loading";
  mocks.error = state === "error" ? new Error("Forbidden") : null;
  const { result } = renderHook(() => useResourceTeams("automation"));
  expect(result.current.teams).toEqual([]);
});
