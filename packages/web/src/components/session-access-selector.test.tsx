// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionAccessSelector } from "./session-access-selector";

expect.extend(matchers);

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

const teams = [
  { id: "team-1", name: "Engineering" },
  { id: "team-2", name: "Design" },
  { id: "team-3", name: "Support" },
];
const props = {
  teamId: null,
  teams,
  visibility: "workspace" as const,
  onTeamChange: vi.fn(),
  onVisibilityChange: vi.fn(),
};

async function selectTeam(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("combobox", { name: "Team context" }));
  await user.click(await screen.findByRole("option", { name }));
}

describe("SessionAccessSelector", () => {
  it.each([
    ["private", "Private"],
    ["team", "Engineering team"],
    ["workspace", "Workspace"],
  ] as const)(
    "labels %s access and describes audience separately from team context",
    async (visibility, label) => {
      const user = userEvent.setup();
      const view = render(
        <SessionAccessSelector {...props} teamId="team-1" visibility={visibility} />
      );
      const trigger = screen.getByRole("button", {
        name: `Session access: ${label}; team context: Engineering`,
      });
      expect(trigger).toHaveTextContent(label);
      await user.click(trigger);
      const dialog = screen.getByRole("dialog", { name: "Session access" });
      const audience = within(dialog).getByRole("radiogroup", { name: "Session audience" });
      expect(within(audience).getByRole("radio", { name: label })).toBeChecked();
      expect(within(audience).getByRole("radio", { name: "Private" })).toHaveAccessibleDescription(
        "Session owner and added collaborators; workspace owners have audited access"
      );
      expect(
        within(audience).getByRole("radio", { name: "Engineering team" })
      ).toHaveAccessibleDescription("Team members and workspace admins");
      expect(
        within(audience).getByRole("radio", { name: "Workspace" })
      ).toHaveAccessibleDescription("Anyone in your workspace with session access");
      expect(
        within(dialog).getByRole("combobox", { name: "Team context" })
      ).toHaveAccessibleDescription("Groups the session; does not grant viewing access.");

      view.rerender(<SessionAccessSelector {...props} teamId="team-2" visibility={visibility} />);
      expect(screen.getByRole("radio", { name: "Design team" })).toHaveAccessibleDescription(
        "Team members and workspace admins"
      );
      expect(trigger).toHaveAccessibleName(
        `Session access: ${visibility === "team" ? "Design team" : label}; team context: Design`
      );
    }
  );

  it.each([
    ["private", "Private"],
    ["team", "Engineering team"],
    ["workspace", "Workspace"],
  ] as const)(
    "chooses %s access, closes the popover, and restores trigger focus",
    async (visibility, label) => {
      const user = userEvent.setup();
      render(
        <SessionAccessSelector
          {...props}
          teamId="team-1"
          visibility={visibility === "workspace" ? "private" : "workspace"}
        />
      );
      const trigger = screen.getByRole("button", { name: /^Session access:/ });
      await user.click(trigger);
      await user.click(screen.getByRole("radio", { name: label }));
      expect(props.onVisibilityChange).toHaveBeenCalledExactlyOnceWith(visibility);
      expect(props.onTeamChange).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog", { name: "Session access" })).not.toBeInTheDocument();
      await waitFor(() => expect(trigger).toHaveFocus());
    }
  );

  it.each(["{Enter}", "[Space]"])(
    "roves vertically without changing audience until %s chooses it",
    async (key) => {
      const user = userEvent.setup();
      render(<SessionAccessSelector {...props} teamId="team-1" visibility="private" />);
      const trigger = screen.getByRole("button", { name: /^Session access:/ });
      trigger.focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(screen.getByRole("radio", { name: "Private" })).toHaveFocus());
      await user.keyboard("{ArrowDown}");
      expect(screen.getByRole("radio", { name: "Engineering team" })).toHaveFocus();
      await user.keyboard("{ArrowDown}");
      expect(screen.getByRole("radio", { name: "Workspace" })).toHaveFocus();
      await user.keyboard("{ArrowUp}");
      expect(screen.getByRole("radio", { name: "Engineering team" })).toHaveFocus();
      expect(screen.getByRole("radio", { name: "Private" })).toBeChecked();
      expect(props.onVisibilityChange).not.toHaveBeenCalled();
      await user.keyboard(key);
      expect(props.onVisibilityChange).toHaveBeenCalledExactlyOnceWith("team");
      expect(screen.queryByRole("dialog", { name: "Session access" })).not.toBeInTheDocument();
      await waitFor(() => expect(trigger).toHaveFocus());
    }
  );

  it("dismisses the nested team dropdown before the access popover and restores focus at each step", async () => {
    const user = userEvent.setup();
    render(<SessionAccessSelector {...props} />);
    const trigger = screen.getByRole("button", { name: /^Session access:/ });
    await user.click(trigger);
    const contextTrigger = screen.getByRole("combobox", { name: "Team context" });
    await user.click(contextTrigger);
    expect(await screen.findByRole("listbox")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Session access" })).toBeInTheDocument();
    await waitFor(() => expect(contextTrigger).toHaveFocus());

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Session access" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("disables Team access without a team and team context without memberships", async () => {
    const user = userEvent.setup();
    render(<SessionAccessSelector {...props} teams={[]} />);
    await user.click(
      screen.getByRole("button", {
        name: "Session access: Workspace; team context: No team",
      })
    );
    const teamAudience = screen.getByRole("radio", { name: "Team" });
    expect(teamAudience).toBeDisabled();
    expect(teamAudience).toHaveAccessibleDescription("Choose a team context first");
    expect(screen.getByRole("combobox", { name: "Team context" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Private" })).not.toBeDisabled();
    expect(screen.getByRole("radio", { name: "Workspace" })).toBeChecked();
    await user.click(teamAudience);
    expect(props.onVisibilityChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Session access" })).toBeInTheDocument();
  });

  it.each([1, 3])(
    "offers all %i memberships and maps No team to null without changing audience",
    async (count) => {
      const user = userEvent.setup();
      const memberships = teams.slice(0, count);
      const chosen = memberships[count - 1];
      const view = render(<SessionAccessSelector {...props} teams={memberships} />);
      await user.click(screen.getByRole("button", { name: /^Session access:/ }));
      await user.click(screen.getByRole("combobox", { name: "Team context" }));
      const options = within(await screen.findByRole("listbox"));
      expect(options.getAllByRole("option")).toHaveLength(count + 1);
      expect(options.getByRole("option", { name: "No team" })).not.toHaveAttribute(
        "aria-disabled",
        "true"
      );
      for (const membership of memberships) {
        expect(options.getByRole("option", { name: membership.name })).toBeInTheDocument();
      }
      await user.click(options.getByRole("option", { name: chosen.name }));
      expect(props.onTeamChange).toHaveBeenCalledExactlyOnceWith(chosen.id);
      expect(screen.getByRole("dialog", { name: "Session access" })).toBeInTheDocument();
      view.rerender(<SessionAccessSelector {...props} teams={memberships} teamId={chosen.id} />);
      expect(screen.getByRole("radio", { name: `${chosen.name} team` })).not.toBeDisabled();
      await selectTeam(user, "No team");
      expect(props.onTeamChange).toHaveBeenLastCalledWith(null);
      expect(props.onVisibilityChange).not.toHaveBeenCalled();
    }
  );

  it("prevents removing team context for Team access until a non-team audience is chosen", async () => {
    const user = userEvent.setup();
    const view = render(<SessionAccessSelector {...props} teamId="team-1" visibility="team" />);
    await user.click(screen.getByRole("button", { name: /^Session access:/ }));
    await user.click(screen.getByRole("combobox", { name: "Team context" }));
    const noTeam = await screen.findByRole("option", { name: "No team" });
    expect(noTeam).toHaveAttribute("aria-disabled", "true");
    expect(noTeam).toHaveAttribute("title", "Choose Private or Workspace first");
    await user.click(noTeam);
    expect(props.onTeamChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("option", { name: "Engineering" }));
    await user.click(screen.getByRole("radio", { name: "Private" }));
    expect(props.onVisibilityChange).toHaveBeenCalledExactlyOnceWith("private");
    view.rerender(<SessionAccessSelector {...props} teamId="team-1" visibility="private" />);
    await user.click(screen.getByRole("button", { name: /^Session access:/ }));
    await selectTeam(user, "No team");
    expect(props.onTeamChange).toHaveBeenCalledExactlyOnceWith(null);
  });

  it.each([1, 3])("omits No team when a team is required with %i memberships", async (count) => {
    const user = userEvent.setup();
    const memberships = teams.slice(0, count);
    render(
      <SessionAccessSelector {...props} teams={memberships} teamId="team-1" requireTeamOnCreate />
    );
    await user.click(screen.getByRole("button", { name: /^Session access:/ }));
    const context = screen.getByRole("combobox", { name: "Team context" });
    expect(context).not.toBeDisabled();
    await user.click(context);
    const options = within(await screen.findByRole("listbox"));
    expect(options.getAllByRole("option")).toHaveLength(count);
    expect(options.queryByRole("option", { name: "No team" })).not.toBeInTheDocument();
    for (const membership of memberships) {
      expect(options.getByRole("option", { name: membership.name })).toBeInTheDocument();
    }
  });

  it("disables the trigger while unavailable", async () => {
    const user = userEvent.setup();
    render(<SessionAccessSelector {...props} disabled />);
    const trigger = screen.getByRole("button", { name: /^Session access:/ });
    expect(trigger).toBeDisabled();
    await user.click(trigger);
    expect(screen.queryByRole("dialog", { name: "Session access" })).not.toBeInTheDocument();
    expect(props.onTeamChange).not.toHaveBeenCalled();
    expect(props.onVisibilityChange).not.toHaveBeenCalled();
  });

  it("disables audience choices before readiness while allowing a required team to be chosen", async () => {
    const user = userEvent.setup();
    render(<SessionAccessSelector {...props} visibilityDisabled requireTeamOnCreate />);
    const trigger = screen.getByRole("button", { name: /^Session access:/ });
    expect(trigger).not.toBeDisabled();
    await user.click(trigger);
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toBeDisabled();
      await user.click(radio);
    }
    expect(props.onVisibilityChange).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "Team context" })).not.toBeDisabled();
    await selectTeam(user, "Engineering");
    expect(props.onTeamChange).toHaveBeenCalledExactlyOnceWith("team-1");
  });
});
