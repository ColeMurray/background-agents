// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamSwitcher } from "./team-switcher";

const state = vi.hoisted(() => ({
  teams: [] as { id: string; name: string }[],
  roleKey: "member",
  setActiveTeam: vi.fn(),
}));
vi.mock("@/hooks/use-active-team", () => ({
  useActiveTeam: () => ({
    teams: state.teams,
    activeTeamId: null,
    scope: "workspace",
    setActiveTeam: state.setActiveTeam,
  }),
}));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({ authorization: { role: { key: state.roleKey } } }),
}));
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: React.ReactNode;
  }) => (
    <select
      aria-label="Active team"
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

beforeEach(() => {
  state.teams = [];
  state.roleKey = "member";
  state.setActiveTeam.mockClear();
});
afterEach(cleanup);

describe("team switcher", () => {
  it.each([0, 1])("is hidden with %i active memberships", (count) => {
    state.teams = [{ id: "team_alpha", name: "Alpha" }].slice(0, count);
    render(<TeamSwitcher />);
    expect(screen.queryByRole("combobox")).toBeNull();
  });
  it("shows Workspace first, active memberships and All my teams for a two-team member", () => {
    state.teams = [
      { id: "team_alpha", name: "Alpha" },
      { id: "team_beta", name: "Beta" },
    ];
    render(<TeamSwitcher />);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Workspace",
      "Alpha",
      "Beta",
      "All my teams",
    ]);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "team_beta" } });
    expect(state.setActiveTeam).toHaveBeenCalledWith("team_beta");
  });
  it.each(["owner", "administrator"])("offers All teams to a server-authorized %s", (roleKey) => {
    state.teams = [
      { id: "team_alpha", name: "Alpha" },
      { id: "team_beta", name: "Beta" },
    ];
    state.roleKey = roleKey;
    render(<TeamSwitcher />);
    expect(screen.getByRole("option", { name: "All teams" })).toBeTruthy();
  });
});
