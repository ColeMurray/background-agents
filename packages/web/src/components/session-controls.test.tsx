// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamResponse } from "@/hooks/use-teams";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { MoveSessionDialog } from "./move-session-dialog";
import { SessionVisibilityControl } from "./session-visibility-control";
import { CollaboratorsSection } from "./sidebar/collaborators-section";

expect.extend(matchers);

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = vi.fn();
});

const mocks = vi.hoisted(() => ({
  teams: [] as TeamResponse[],
  memberships: [] as TeamResponse[],
  teamsLoading: false,
  teamsError: null as Error | null,
  membershipsLoading: false,
  membershipsError: null as Error | null,
  members: [] as Array<{ userId: string }>,
  membersLoading: false,
  membersError: null as Error | null,
  useMembers: vi.fn(),
  candidates: [] as Array<{
    userId: string;
    displayName: string | null;
    email: string | null;
    avatarUrl: string | null;
  }>,
  candidatesLoading: false,
  directoryError: null as Error | null,
  useCandidates: vi.fn(),
  mutate: vi.fn(),
  updated: vi.fn(),
  openChange: vi.fn(),
}));

vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));
vi.mock("swr", () => ({ useSWRConfig: () => ({ mutate: mocks.mutate, cache: new Map() }) }));
vi.mock("@/hooks/use-session-collaborator-candidates", () => ({
  useSessionCollaboratorCandidates: (sessionId: string, enabled: boolean) => {
    mocks.useCandidates(sessionId, enabled);
    return {
      candidates: enabled ? mocks.candidates : [],
      loading: mocks.candidatesLoading,
      error: mocks.directoryError,
    };
  },
}));
vi.mock("@/hooks/use-teams", () => ({
  useTeams: () => ({
    teams: mocks.teams,
    loading: mocks.teamsLoading,
    error: mocks.teamsError,
  }),
  useMeTeams: () => ({
    teams: mocks.memberships,
    loading: mocks.membershipsLoading,
    error: mocks.membershipsError,
  }),
  useTeamMembers: (id: string) => {
    mocks.useMembers(id);
    return { members: mocks.members, loading: mocks.membersLoading, error: mocks.membersError };
  },
}));

const capabilities = {
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
const team: TeamResponse = {
  id: "target",
  slug: "target",
  name: "Target team",
  description: null,
  joinPolicy: "invite_only",
  defaultVisibility: "workspace",
  defaultEnvironmentId: null,
  grantsVersion: 1,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  memberCount: 1,
  capabilities,
};
const baseProps = {
  sessionId: "session/id",
  ownerTeamId: "source",
  ownerUserId: "owner",
  visibility: "team" as const,
  onUpdated: mocks.updated,
};
const moveProps = {
  ...baseProps,
  open: true,
  onOpenChange: mocks.openChange,
  canMove: true,
};

function selectTarget() {
  fireEvent.change(screen.getByRole("combobox", { name: "Destination" }), {
    target: { value: team.id },
  });
}
async function selectVisibility(name: string) {
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Visibility" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("option", { name }));
}
function expectMutation(path: string, body: object, method = "PUT") {
  expect(browserApiFetch).toHaveBeenLastCalledWith(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  mocks.teams = [team];
  mocks.memberships = [team];
  mocks.teamsLoading = false;
  mocks.teamsError = null;
  mocks.membershipsLoading = false;
  mocks.membershipsError = null;
  mocks.members = [{ userId: "owner" }];
  mocks.membersLoading = false;
  mocks.membersError = null;
  mocks.candidatesLoading = false;
  mocks.directoryError = null;
  mocks.candidates = [
    { userId: "owner", displayName: "Owner", email: null, avatarUrl: null },
    { userId: "ada", displayName: "Ada", email: "ada@example.com", avatarUrl: null },
    { userId: "grace/id", displayName: "Grace", email: null, avatarUrl: null },
  ];
  mocks.updated.mockResolvedValue(undefined);
  mocks.mutate.mockResolvedValue(undefined);
  vi.mocked(browserApiFetch).mockResolvedValue(Response.json({ ok: true }));
});
afterEach(cleanup);

describe("MoveSessionDialog", () => {
  it("moves a member's session with children by default and refreshes before closing", async () => {
    render(<MoveSessionDialog {...moveProps} />);
    selectTarget();
    expect(screen.getByRole("checkbox", { name: "Include child sessions" })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: /Join/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Move session" }));
    await waitFor(() => expect(mocks.openChange).toHaveBeenCalledWith(false));
    expectMutation("/api/sessions/session%2Fid/scope", {
      teamId: "target",
      includeChildren: true,
      joinTeam: false,
    });
    expect(mocks.updated).toHaveBeenCalledOnce();
    expect(mocks.mutate).toHaveBeenCalledWith(expect.any(Function));
  });

  it("requires opt-in joining only for an open nonmember target with canJoin", async () => {
    mocks.memberships = [];
    mocks.teams = [
      { ...team, joinPolicy: "open", capabilities: { ...capabilities, canJoin: true } },
    ];
    render(<MoveSessionDialog {...moveProps} />);
    selectTarget();
    expect(screen.getByRole("button", { name: "Move session" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Join target team" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Include child sessions" }));
    fireEvent.click(screen.getByRole("button", { name: "Move session" }));
    await waitFor(() => expect(mocks.updated).toHaveBeenCalledOnce());
    expectMutation("/api/sessions/session%2Fid/scope", {
      teamId: "target",
      includeChildren: false,
      joinTeam: true,
    });
  });

  it.each([
    { joinPolicy: "open" as const, caps: capabilities },
    { joinPolicy: "invite_only" as const, caps: { ...capabilities, canJoin: true } },
    { joinPolicy: "open" as const, caps: undefined },
  ])(
    "does not offer joining when policy or capabilities deny it: $joinPolicy $caps",
    ({ joinPolicy, caps }) => {
      mocks.memberships = [];
      mocks.teams = [{ ...team, joinPolicy, capabilities: caps }];
      render(<MoveSessionDialog {...moveProps} />);
      selectTarget();
      expect(screen.queryByRole("checkbox", { name: "Join target team" })).toBeNull();
      expect(screen.getByRole("button", { name: "Move session" })).toBeDisabled();
    }
  );

  it("does not treat team management as target membership for a move", () => {
    mocks.memberships = [];
    mocks.teams = [{ ...team, capabilities: { ...capabilities, canManageMembers: true } }];
    render(<MoveSessionDialog {...moveProps} />);
    selectTarget();
    expect(screen.queryByRole("checkbox", { name: "Join target team" })).toBeNull();
    expect(screen.getByRole("button", { name: "Move session" })).toBeDisabled();
    expect(browserApiFetch).not.toHaveBeenCalled();
  });

  it.each(["loading", "error"])("does not offer joining while membership is %s", (state) => {
    mocks.memberships = [];
    mocks.teams = [
      { ...team, joinPolicy: "open", capabilities: { ...capabilities, canJoin: true } },
    ];
    const { rerender } = render(<MoveSessionDialog {...moveProps} />);
    selectTarget();
    if (state === "loading") mocks.membershipsLoading = true;
    else mocks.membershipsError = new Error("Membership unavailable");
    rerender(<MoveSessionDialog {...moveProps} />);
    expect(screen.queryByRole("checkbox", { name: "Join target team" })).toBeNull();
    expect(screen.getByRole("button", { name: "Move session" })).toBeDisabled();
  });

  it("warns from target membership, not participants, when the team-visible owner is absent", () => {
    mocks.members = [{ userId: "someone_else" }];
    render(<MoveSessionDialog {...moveProps} />);
    selectTarget();
    expect(mocks.useMembers).toHaveBeenCalledWith("target");
    expect(screen.getByText(/owner is not a member.*may lose access/i)).toBeInTheDocument();
  });

  it("moves to workspace with null scope and explains team visibility conversion", async () => {
    render(<MoveSessionDialog {...moveProps} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Destination" }), {
      target: { value: "" },
    });
    expect(screen.getByText(/visibility will change to workspace/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Move session" }));
    await waitFor(() => expect(mocks.updated).toHaveBeenCalledOnce());
    expectMutation("/api/sessions/session%2Fid/scope", {
      teamId: null,
      includeChildren: true,
      joinTeam: false,
    });
  });

  it.each([
    [403, { error: "Forbidden", reason_code: "not_owner" }],
    [404, { error: "Session not found" }],
    [409, { error: "Descendant inaccessible", code: "descendant_inaccessible" }],
  ])(
    "offers an explicit retry without children after cascade status %s",
    async (status, failure) => {
      vi.mocked(browserApiFetch).mockResolvedValueOnce(Response.json(failure, { status }));
      render(<MoveSessionDialog {...moveProps} />);
      selectTarget();
      fireEvent.click(screen.getByRole("button", { name: "Move session" }));
      const retry = await screen.findByRole("button", { name: "Retry without child sessions" });
      expect(browserApiFetch).toHaveBeenCalledOnce();
      expect(mocks.updated).not.toHaveBeenCalled();
      fireEvent.click(retry);
      await waitFor(() => expect(mocks.updated).toHaveBeenCalledOnce());
      expectMutation("/api/sessions/session%2Fid/scope", {
        teamId: "target",
        includeChildren: false,
        joinTeam: false,
      });
      expect(screen.getByRole("checkbox", { name: "Include child sessions" })).not.toBeChecked();
    }
  );

  it("displays missing repository grants without offering a cascade retry", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json(
        {
          error: "Target team lacks repository grant",
          code: "target_team_missing_grant",
          repository: "group/subgroup/repo",
        },
        { status: 409 }
      )
    );
    render(<MoveSessionDialog {...moveProps} />);
    selectTarget();
    fireEvent.click(screen.getByRole("button", { name: "Move session" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("group/subgroup/repo");
    expect(screen.queryByRole("button", { name: "Retry without child sessions" })).toBeNull();
  });

  it.each(["capability", "team capabilities", "loading", "error"])(
    "guards a move when %s is missing",
    (missing) => {
      if (missing === "team capabilities") mocks.teams = [{ ...team, capabilities: undefined }];
      if (missing === "loading") mocks.teamsLoading = true;
      if (missing === "error") mocks.teamsError = new Error("Unavailable");
      render(<MoveSessionDialog {...moveProps} canMove={missing !== "capability"} />);
      selectTarget();
      fireEvent.click(screen.getByRole("button", { name: "Move session" }));
      expect(browserApiFetch).not.toHaveBeenCalled();
    }
  );

  it("does not retain join consent across target changes and resets on reopen", () => {
    mocks.memberships = [];
    mocks.teams = [
      { ...team, joinPolicy: "open", capabilities: { ...capabilities, canJoin: true } },
    ];
    const { rerender } = render(<MoveSessionDialog {...moveProps} />);
    selectTarget();
    fireEvent.click(screen.getByRole("checkbox", { name: "Join target team" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Destination" }), {
      target: { value: "" },
    });
    selectTarget();
    expect(screen.getByRole("checkbox", { name: "Join target team" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Include child sessions" }));
    rerender(<MoveSessionDialog {...moveProps} open={false} />);
    rerender(<MoveSessionDialog {...moveProps} />);
    expect(screen.getByRole("checkbox", { name: "Include child sessions" })).toBeChecked();
  });

  it("labels an unavailable current team instead of displaying workspace for a non-null scope", () => {
    mocks.teams = [];
    render(<MoveSessionDialog {...moveProps} />);
    expect(screen.getByRole("combobox", { name: "Destination" })).toHaveValue("source");
    expect(screen.getByRole("option", { name: "Current team unavailable" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move session" })).toBeDisabled();
  });

  it("does not offer cascade retry when children were already excluded", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({ error: "Team not found" }, { status: 404 })
    );
    render(<MoveSessionDialog {...moveProps} />);
    selectTarget();
    fireEvent.click(screen.getByRole("checkbox", { name: "Include child sessions" }));
    fireEvent.click(screen.getByRole("button", { name: "Move session" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Team not found");
    expect(screen.queryByRole("button", { name: "Retry without child sessions" })).toBeNull();
  });

  it("keeps the dialog pending until snapshot refresh finishes and prevents duplicate requests", async () => {
    let finishRefresh!: () => void;
    mocks.updated.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        })
    );
    render(<MoveSessionDialog {...moveProps} />);
    selectTarget();
    fireEvent.click(screen.getByRole("button", { name: "Move session" }));
    await waitFor(() => expect(mocks.updated).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Moving..." })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Moving..." }));
    expect(browserApiFetch).toHaveBeenCalledOnce();
    expect(mocks.openChange).not.toHaveBeenCalled();
    finishRefresh();
    await waitFor(() => expect(mocks.openChange).toHaveBeenCalledWith(false));
  });
});

describe("SessionVisibilityControl", () => {
  it("uses the shared dropdown and saves the selected visibility and child-session scope", async () => {
    render(<SessionVisibilityControl {...baseProps} canChangeVisibility />);
    expect(screen.getByRole("combobox", { name: "Visibility" }).tagName).toBe("BUTTON");
    expect(screen.getByRole("checkbox", { name: "Include child sessions" })).toBeChecked();
    await selectVisibility("Private");
    expect(screen.getByRole("combobox", { name: "Visibility" })).toHaveTextContent("Private");
    fireEvent.click(screen.getByRole("checkbox", { name: "Include child sessions" }));
    expect(browserApiFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.updated).toHaveBeenCalledOnce());
    expectMutation("/api/sessions/session%2Fid/visibility", {
      visibility: "private",
      includeChildren: false,
    });
    expect(mocks.mutate).toHaveBeenCalledWith(expect.any(Function));
  });

  it("loads membership for the owner team and warns before selecting team visibility", async () => {
    mocks.members = [];
    render(<SessionVisibilityControl {...baseProps} visibility="private" canChangeVisibility />);
    await selectVisibility("Team");
    expect(mocks.useMembers).toHaveBeenCalledWith("source");
    expect(screen.getByText(/owner is not a member.*may lose access/i)).toBeInTheDocument();
  });

  it("disables unavailable team/private options and all mutations without capabilities", async () => {
    const { rerender } = render(
      <SessionVisibilityControl
        {...baseProps}
        ownerTeamId={null}
        ownerUserId={null}
        visibility="workspace"
        canChangeVisibility={false}
      />
    );
    expect(screen.getByRole("combobox", { name: "Visibility" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(browserApiFetch).not.toHaveBeenCalled();
    rerender(
      <SessionVisibilityControl
        {...baseProps}
        ownerTeamId={null}
        ownerUserId={null}
        visibility="workspace"
        canChangeVisibility
      />
    );
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Visibility" }), { key: "Enter" });
    expect(await screen.findByRole("option", { name: "Team" })).toHaveAttribute(
      "aria-disabled",
      "true"
    );
    expect(screen.getByRole("option", { name: "Private" })).toHaveAttribute(
      "aria-disabled",
      "true"
    );
  });

  it.each(["workspace", "team", "private"] as const)(
    "disables applying unchanged %s visibility even when children are included",
    (visibility) => {
      render(
        <SessionVisibilityControl {...baseProps} visibility={visibility} canChangeVisibility />
      );
      const apply = screen.getByRole("button", { name: "Save" });
      expect(apply).toBeDisabled();
      fireEvent.click(apply);
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(browserApiFetch).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("checkbox", { name: "Include child sessions" }));
      expect(apply).toBeDisabled();
      fireEvent.click(apply);
      expect(browserApiFetch).not.toHaveBeenCalled();
    }
  );

  it("disables apply when the selection returns to the current visibility or a refresh matches it", async () => {
    const { rerender } = render(<SessionVisibilityControl {...baseProps} canChangeVisibility />);
    const apply = screen.getByRole("button", { name: "Save" });
    await selectVisibility("Workspace");
    expect(apply).toBeEnabled();
    await selectVisibility("Team");
    expect(apply).toBeDisabled();
    await selectVisibility("Workspace");
    rerender(
      <SessionVisibilityControl {...baseProps} visibility="workspace" canChangeVisibility />
    );
    expect(apply).toBeDisabled();
    fireEvent.click(apply);
    expect(browserApiFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["private", "workspace"],
    ["private", "team"],
    ["team", "workspace"],
    ["workspace", "team"],
  ] as const)(
    "requires confirmation before changing %s visibility and private children to %s",
    async (visibility, target) => {
      render(
        <SessionVisibilityControl {...baseProps} visibility={visibility} canChangeVisibility />
      );
      await selectVisibility(target.charAt(0).toUpperCase() + target.slice(1));
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      const confirmation = within(screen.getByRole("alertdialog"));
      expect(
        confirmation.getByText(
          new RegExp(`any private child sessions will change to ${target} visibility`, "i")
        )
      ).toBeInTheDocument();
      expect(browserApiFetch).not.toHaveBeenCalled();
      fireEvent.click(confirmation.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(browserApiFetch).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      fireEvent.click(
        within(screen.getByRole("alertdialog")).getByRole("button", { name: "Change visibility" })
      );
      await waitFor(() => expect(mocks.updated).toHaveBeenCalledOnce());
      expect(browserApiFetch).toHaveBeenCalledOnce();
      expectMutation("/api/sessions/session%2Fid/visibility", {
        visibility: target,
        includeChildren: true,
      });
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    }
  );

  it.each([
    ["team", "private", true],
    ["team", "workspace", false],
    ["workspace", "team", false],
  ] as const)(
    "changes %s visibility to %s without confirmation when includeChildren is %s",
    async (visibility, target, includeChildren) => {
      render(
        <SessionVisibilityControl {...baseProps} visibility={visibility} canChangeVisibility />
      );
      await selectVisibility(target.charAt(0).toUpperCase() + target.slice(1));
      if (!includeChildren)
        fireEvent.click(screen.getByRole("checkbox", { name: "Include child sessions" }));
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      await waitFor(() => expect(mocks.updated).toHaveBeenCalledOnce());
      expectMutation("/api/sessions/session%2Fid/visibility", {
        visibility: target,
        includeChildren,
      });
    }
  );

  it("guards confirmation when the visibility capability is revoked", async () => {
    const { rerender } = render(<SessionVisibilityControl {...baseProps} canChangeVisibility />);
    await selectVisibility("Workspace");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    rerender(<SessionVisibilityControl {...baseProps} canChangeVisibility={false} />);
    const confirm = within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Change visibility",
    });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(browserApiFetch).not.toHaveBeenCalled();
  });

  it("retries a cascade only after an explicit click and keeps selected visibility", async () => {
    vi.mocked(browserApiFetch).mockResolvedValueOnce(
      Response.json(
        { error: "Forbidden", code: "session_action_denied", reason_code: "not_owner" },
        { status: 403 }
      )
    );
    render(<SessionVisibilityControl {...baseProps} canChangeVisibility />);
    await selectVisibility("Workspace");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(browserApiFetch).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Change visibility" })
    );
    const retry = await screen.findByRole("button", { name: "Retry without child sessions" });
    expect(screen.getByRole("alert")).toHaveTextContent("not_owner");
    expect(browserApiFetch).toHaveBeenCalledOnce();
    fireEvent.click(retry);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.updated).toHaveBeenCalledOnce());
    expect(browserApiFetch).toHaveBeenCalledTimes(2);
    expectMutation("/api/sessions/session%2Fid/visibility", {
      visibility: "workspace",
      includeChildren: false,
    });
    expect(screen.getByRole("checkbox", { name: "Include child sessions" })).not.toBeChecked();
  });

  it("guards a retry without children when the visibility capability is revoked", async () => {
    vi.mocked(browserApiFetch).mockResolvedValueOnce(
      Response.json(
        { error: "Descendant inaccessible", code: "descendant_inaccessible" },
        { status: 409 }
      )
    );
    const { rerender } = render(<SessionVisibilityControl {...baseProps} canChangeVisibility />);
    await selectVisibility("Private");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const retry = await screen.findByRole("button", { name: "Retry without child sessions" });
    rerender(<SessionVisibilityControl {...baseProps} canChangeVisibility={false} />);
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(browserApiFetch).toHaveBeenCalledOnce();
    expect(mocks.updated).not.toHaveBeenCalled();
  });

  it.each(["owner_required", "team_required"])("preserves server %s errors", async (code) => {
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({ error: "Invalid visibility", code }, { status: 400 })
    );
    render(<SessionVisibilityControl {...baseProps} canChangeVisibility />);
    await selectVisibility("Private");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(code);
    expect(screen.queryByRole("button", { name: "Retry without child sessions" })).toBeNull();
  });

  it("disables all controls until the updated snapshot finishes refreshing", async () => {
    let finishRefresh!: () => void;
    mocks.updated.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        })
    );
    render(<SessionVisibilityControl {...baseProps} canChangeVisibility />);
    await selectVisibility("Private");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.updated).toHaveBeenCalledOnce());
    expect(screen.getByRole("combobox", { name: "Visibility" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Include child sessions" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Updating..." })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Updating..." }));
    expect(browserApiFetch).toHaveBeenCalledOnce();
    finishRefresh();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Visibility" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});

describe("CollaboratorsSection", () => {
  async function selectGrace() {
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Add collaborator" }));
    await user.click(await screen.findByRole("option", { name: "Grace" }));
  }

  const props = {
    sessionId: "session/id",
    ownerUserId: "owner",
    collaborators: ["ada", "unknown"],
    canManageCollaborators: true,
    onUpdated: mocks.updated,
  };

  it("resolves IDs from scoped active candidates and excludes owner and existing collaborators", async () => {
    render(<CollaboratorsSection {...props} />);
    expect(mocks.useCandidates).toHaveBeenCalledWith("session/id", true);
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("Unnamed user \u00b7 nknown")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("combobox", { name: "Add collaborator" }));
    expect(screen.getByRole("option", { name: "Grace" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Owner" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Ada" })).toBeNull();
  });

  it("adds a candidate via PUT and refreshes snapshot and lists", async () => {
    render(<CollaboratorsSection {...props} />);
    await selectGrace();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(mocks.updated).toHaveBeenCalledOnce());
    expect(browserApiFetch).toHaveBeenCalledWith(
      "/api/sessions/session%2Fid/collaborators/grace%2Fid",
      { method: "PUT" }
    );
    expect(mocks.mutate).toHaveBeenCalledWith(expect.any(Function));
    expect(screen.getByRole("combobox", { name: "Add collaborator" })).toHaveTextContent(
      "Select a workspace member"
    );
  });

  it("removes an existing collaborator via DELETE and refreshes", async () => {
    render(<CollaboratorsSection {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Ada" }));
    await waitFor(() => expect(mocks.updated).toHaveBeenCalledOnce());
    expect(browserApiFetch).toHaveBeenCalledWith("/api/sessions/session%2Fid/collaborators/ada", {
      method: "DELETE",
    });
    expect(mocks.mutate).toHaveBeenCalledWith(expect.any(Function));
  });

  it.each([
    [403, { error: "Forbidden", reason_code: "not_owner" }, "not_owner"],
    [404, { error: "User not found" }, "User not found"],
    [409, { error: "User inactive", code: "user_inactive" }, "user_inactive"],
  ])(
    "preserves collaborator status %s errors without refreshing",
    async (status, failure, message) => {
      vi.mocked(browserApiFetch).mockResolvedValue(Response.json(failure, { status }));
      render(<CollaboratorsSection {...props} />);
      await selectGrace();
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(mocks.updated).not.toHaveBeenCalled();
      expect(mocks.mutate).not.toHaveBeenCalled();
    }
  );

  it("hides the section and guards a revoked capability", async () => {
    const { rerender } = render(<CollaboratorsSection {...props} />);
    await selectGrace();
    rerender(<CollaboratorsSection {...props} canManageCollaborators={false} />);
    expect(screen.queryByText("Collaborators")).toBeNull();
    expect(mocks.useCandidates).toHaveBeenLastCalledWith("session/id", false);
    expect(browserApiFetch).not.toHaveBeenCalled();
  });

  it.each(["loading", "error"])(
    "guards adding while scoped candidates are %s but still permits removal",
    (state) => {
      mocks.candidates = [];
      mocks.candidatesLoading = state === "loading";
      if (state === "error") mocks.directoryError = new Error("Unavailable");
      render(<CollaboratorsSection {...props} />);
      expect(mocks.useCandidates).toHaveBeenCalledWith("session/id", true);
      expect(screen.getByRole("combobox", { name: "Add collaborator" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Remove Unnamed user \u00b7 ada" })).toBeEnabled();
      if (state === "error")
        expect(screen.getByRole("alert")).toHaveTextContent("Failed to load workspace members");
      expect(browserApiFetch).not.toHaveBeenCalled();
    }
  );
});
