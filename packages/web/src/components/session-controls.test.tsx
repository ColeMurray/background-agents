// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { SessionVisibilityControl } from "./session-visibility-control";
import { CollaboratorsSection } from "./sidebar/collaborators-section";

expect.extend(matchers);

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = vi.fn();
});

const mocks = vi.hoisted(() => ({
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
  useTeamMembers: (id: string) => {
    mocks.useMembers(id);
    return { members: mocks.members, loading: mocks.membersLoading, error: mocks.membersError };
  },
}));

const baseProps = {
  sessionId: "session/id",
  ownerTeamId: "source",
  ownerUserId: "owner",
  visibility: "team" as const,
  onUpdated: mocks.updated,
};
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

describe("SessionVisibilityControl", () => {
  const childrenBox = () => screen.getByRole("checkbox", { name: "Include child sessions" });
  const confirmButton = () =>
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "Change visibility" });

  it("saves immediately when a visibility is selected, without a save button", async () => {
    render(<SessionVisibilityControl {...baseProps} canChangeVisibility />);
    expect(screen.getByRole("combobox", { name: "Visibility" }).tagName).toBe("BUTTON");
    expect(childrenBox()).toBeChecked();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    await selectVisibility("Private");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.updated).toHaveBeenCalledOnce());
    expectMutation("/api/sessions/session%2Fid/visibility", {
      visibility: "private",
      includeChildren: true,
    });
    expect(mocks.mutate).toHaveBeenCalledWith(expect.any(Function));
  });

  it("scopes later changes to this session after unchecking children without saving", async () => {
    render(<SessionVisibilityControl {...baseProps} canChangeVisibility />);
    fireEvent.click(childrenBox());
    expect(childrenBox()).not.toBeChecked();
    expect(browserApiFetch).not.toHaveBeenCalled();
    await selectVisibility("Workspace");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.updated).toHaveBeenCalledOnce());
    expectMutation("/api/sessions/session%2Fid/visibility", {
      visibility: "workspace",
      includeChildren: false,
    });
  });

  it.each(["workspace", "team"] as const)(
    "confirms before checking children applies %s visibility to them",
    async (visibility) => {
      render(
        <SessionVisibilityControl {...baseProps} visibility={visibility} canChangeVisibility />
      );
      fireEvent.click(childrenBox());
      fireEvent.click(childrenBox());
      expect(browserApiFetch).not.toHaveBeenCalled();
      fireEvent.click(confirmButton());
      await waitFor(() => expect(mocks.updated).toHaveBeenCalledOnce());
      expectMutation("/api/sessions/session%2Fid/visibility", {
        visibility,
        includeChildren: true,
      });
      expect(childrenBox()).toBeChecked();
    }
  );

  it("applies private visibility to children immediately when checked", async () => {
    render(<SessionVisibilityControl {...baseProps} visibility="private" canChangeVisibility />);
    fireEvent.click(childrenBox());
    fireEvent.click(childrenBox());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.updated).toHaveBeenCalledOnce());
    expectMutation("/api/sessions/session%2Fid/visibility", {
      visibility: "private",
      includeChildren: true,
    });
  });

  it("does not save when the current visibility is reselected", async () => {
    render(<SessionVisibilityControl {...baseProps} canChangeVisibility />);
    await selectVisibility("Team");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(browserApiFetch).not.toHaveBeenCalled();
  });

  it("loads membership for the owner team and warns about team visibility", async () => {
    mocks.members = [];
    render(<SessionVisibilityControl {...baseProps} visibility="private" canChangeVisibility />);
    await selectVisibility("Team");
    expect(mocks.useMembers).toHaveBeenCalledWith("source");
    expect(screen.getByText(/owner is not a member.*may lose access/i)).toBeInTheDocument();
  });

  it("disables unavailable team/private options and all controls without capabilities", async () => {
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
    expect(childrenBox()).toBeDisabled();
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
      const label = target.charAt(0).toUpperCase() + target.slice(1);
      await selectVisibility(label);
      const confirmation = within(screen.getByRole("alertdialog"));
      expect(
        confirmation.getByText(
          new RegExp(`any private child sessions will change to ${target} visibility`, "i")
        )
      ).toBeInTheDocument();
      fireEvent.click(confirmation.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(screen.getByRole("combobox", { name: "Visibility" })).not.toHaveTextContent(label);
      expect(browserApiFetch).not.toHaveBeenCalled();

      await selectVisibility(label);
      fireEvent.click(confirmButton());
      await waitFor(() => expect(mocks.updated).toHaveBeenCalledOnce());
      expect(browserApiFetch).toHaveBeenCalledOnce();
      expectMutation("/api/sessions/session%2Fid/visibility", {
        visibility: target,
        includeChildren: true,
      });
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    }
  );

  it("guards confirmation when the visibility capability is revoked", async () => {
    const { rerender } = render(<SessionVisibilityControl {...baseProps} canChangeVisibility />);
    await selectVisibility("Workspace");
    rerender(<SessionVisibilityControl {...baseProps} canChangeVisibility={false} />);
    expect(confirmButton()).toBeDisabled();
    fireEvent.click(confirmButton());
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
    fireEvent.click(confirmButton());
    const retry = await screen.findByRole("button", { name: "Retry without child sessions" });
    expect(screen.getByRole("alert")).toHaveTextContent("not_owner");
    expect(screen.getByRole("combobox", { name: "Visibility" })).toHaveTextContent("Workspace");
    expect(browserApiFetch).toHaveBeenCalledOnce();
    fireEvent.click(retry);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.updated).toHaveBeenCalledOnce());
    expect(browserApiFetch).toHaveBeenCalledTimes(2);
    expectMutation("/api/sessions/session%2Fid/visibility", {
      visibility: "workspace",
      includeChildren: false,
    });
    expect(childrenBox()).not.toBeChecked();
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
    const retry = await screen.findByRole("button", { name: "Retry without child sessions" });
    rerender(<SessionVisibilityControl {...baseProps} canChangeVisibility={false} />);
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(browserApiFetch).toHaveBeenCalledOnce();
    expect(mocks.updated).not.toHaveBeenCalled();
  });

  it.each(["owner_required", "team_required"])(
    "preserves server %s errors and reverts the selection",
    async (code) => {
      vi.mocked(browserApiFetch).mockResolvedValue(
        Response.json({ error: "Invalid visibility", code }, { status: 400 })
      );
      render(<SessionVisibilityControl {...baseProps} canChangeVisibility />);
      await selectVisibility("Private");
      expect(await screen.findByRole("alert")).toHaveTextContent(code);
      expect(screen.queryByRole("button", { name: "Retry without child sessions" })).toBeNull();
      expect(screen.getByRole("combobox", { name: "Visibility" })).toHaveTextContent("Team");
    }
  );

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
    await waitFor(() => expect(mocks.updated).toHaveBeenCalledOnce());
    expect(screen.getByRole("combobox", { name: "Visibility" })).toBeDisabled();
    expect(childrenBox()).toBeDisabled();
    expect(screen.getByText("Updating...")).toBeInTheDocument();
    finishRefresh();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Visibility" })).toBeEnabled());
    expect(screen.queryByText("Updating...")).toBeNull();
    expect(browserApiFetch).toHaveBeenCalledOnce();
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
