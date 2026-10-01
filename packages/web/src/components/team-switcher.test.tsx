// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamSwitcher } from "./team-switcher";

const state = vi.hoisted(() => ({
  teams: [] as { id: string; slug: string; name: string }[],
  activeTeamId: null as string | null,
  scope: "workspace" as string | undefined,
  roleKey: "member",
  setActiveTeam: vi.fn(),
}));
vi.mock("@/hooks/use-active-team", () => ({
  useActiveTeam: () => ({
    teams: state.teams,
    activeTeamId: state.activeTeamId,
    scope: state.scope,
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
  state.activeTeamId = null;
  state.scope = "workspace";
  state.roleKey = "member";
  state.setActiveTeam.mockClear();
});
afterEach(cleanup);

describe("team switcher", () => {
  it("is hidden without active memberships", () => {
    render(<TeamSwitcher />);
    expect(screen.queryByRole("combobox")).toBeNull();
  });
  it("offers the selector with a single active membership", () => {
    state.teams = [{ id: "team_alpha", slug: "alpha", name: "Alpha" }];
    state.scope = undefined;
    render(<TeamSwitcher />);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Workspace",
      "Alpha",
      "All my teams",
    ]);
    expect(screen.getByRole("combobox").getAttribute("aria-label")).toBe("Active team");
  });
  it("shows Workspace first, active memberships and All my teams for a two-team member", () => {
    state.teams = [
      { id: "team_alpha", slug: "alpha", name: "Alpha" },
      { id: "team_beta", slug: "beta", name: "Beta" },
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
      { id: "team_alpha", slug: "alpha", name: "Alpha" },
      { id: "team_beta", slug: "beta", name: "Beta" },
    ];
    state.roleKey = roleKey;
    render(<TeamSwitcher />);
    expect(screen.getByRole("option", { name: "All teams" })).toBeTruthy();
  });

  it("links to the selected team's page and updates the link when the selection changes", () => {
    state.teams = [
      { id: "team_alpha", slug: "alpha", name: "Alpha" },
      { id: "team_beta", slug: "beta", name: "Beta" },
    ];
    state.activeTeamId = "team_alpha";
    state.scope = undefined;
    const { rerender } = render(<TeamSwitcher />);
    expect(screen.getByRole("link", { name: "Alpha team page" }).getAttribute("href")).toBe(
      "/teams/alpha"
    );
    state.activeTeamId = "team_beta";
    rerender(<TeamSwitcher />);
    expect(screen.queryByRole("link", { name: "Alpha team page" })).toBeNull();
    expect(screen.getByRole("link", { name: "Beta team page" }).getAttribute("href")).toBe(
      "/teams/beta"
    );
  });

  it("keeps the selected team's page accessible with a single membership", () => {
    state.teams = [{ id: "team_alpha", slug: "alpha", name: "Alpha" }];
    state.activeTeamId = "team_alpha";
    state.scope = undefined;
    const onNavigate = vi.fn();
    render(<TeamSwitcher onNavigate={onNavigate} />);
    expect(screen.getByRole("combobox")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Alpha team page" });
    expect(link.getAttribute("href")).toBe("/teams/alpha");
    fireEvent.click(link, { ctrlKey: true });
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it.each(["workspace", "all", undefined])(
    "does not offer a team page link for aggregate scope %s",
    (scope) => {
      state.teams = [
        { id: "team_alpha", slug: "alpha", name: "Alpha" },
        { id: "team_beta", slug: "beta", name: "Beta" },
      ];
      state.scope = scope;
      render(<TeamSwitcher />);
      expect(screen.queryByRole("link")).toBeNull();
    }
  );
});
