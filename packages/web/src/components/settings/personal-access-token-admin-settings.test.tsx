// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type {
  PersonalAccessTokenPolicySnapshot,
  WorkspacePersonalAccessToken,
} from "@open-inspect/shared/types/personal-access-tokens";
import { PersonalAccessTokenAdminSettings } from "./personal-access-token-admin-settings";
import {
  SettingsNavigationGuardProvider,
  useConfirmSettingsNavigation,
} from "./settings-navigation-guard";

const hooks = vi.hoisted(() => ({
  policy: null as PersonalAccessTokenPolicySnapshot | null,
  tokens: [] as WorkspacePersonalAccessToken[],
  mutatePolicy: vi.fn(),
  mutateTokens: vi.fn(),
  save: vi.fn(),
  revokeToken: vi.fn(),
  revokeMember: vi.fn(),
}));

vi.mock("@/hooks/use-workspace-personal-access-tokens", () => ({
  useWorkspacePersonalAccessTokenPolicy: () => ({
    policy: hooks.policy,
    loading: false,
    error: undefined,
    mutate: hooks.mutatePolicy,
  }),
  useWorkspacePersonalAccessTokens: () => ({
    tokens: hooks.tokens,
    hasMore: false,
    loadMore: vi.fn(),
    loading: false,
    error: undefined,
    mutate: hooks.mutateTokens,
  }),
  saveWorkspacePersonalAccessTokenPolicy: hooks.save,
  revokeWorkspacePersonalAccessToken: hooks.revokeToken,
  revokeMemberPersonalAccessTokens: hooks.revokeMember,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

expect.extend(matchers);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_POLICY: PersonalAccessTokenPolicySnapshot = {
  enabled: true,
  maxLifetimeDays: null,
  allowedPermissions: null,
  revision: 3,
  updatedAt: null,
  updatedByUserId: null,
};
const MEMBER_TOKEN: WorkspacePersonalAccessToken = {
  id: "token-1",
  name: "CI reader",
  displayPrefix: "oi_pat_a1b2c3",
  permissions: ["sessions.read"],
  createdAt: Date.now() - DAY_MS,
  lastUsedAt: null,
  expiresAt: Date.now() + 29 * DAY_MS,
  owner: { userId: "user-2", displayName: "Ada Member", email: "ada@example.com" },
};

/** Stands in for the settings navigation, which asks the guard before changing category. */
function NavigationProbe({ onNavigate }: { onNavigate: (allowed: boolean) => void }) {
  const confirmNavigation = useConfirmSettingsNavigation();
  return (
    <button type="button" onClick={() => onNavigate(confirmNavigation())}>
      Other settings
    </button>
  );
}

function unloadPrevented(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

async function selectOnlyCeiling(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("radio", { name: /Only those selected/ }));
  // Every grantable permission starts selected; clear them all.
  for (const checkbox of screen.getAllByRole("checkbox")) {
    if (checkbox.getAttribute("aria-checked") === "true") await user.click(checkbox);
  }
}

describe("PersonalAccessTokenAdminSettings", () => {
  beforeEach(() => {
    hooks.policy = OPEN_POLICY;
    hooks.tokens = [];
    for (const mock of [
      hooks.mutatePolicy,
      hooks.mutateTokens,
      hooks.save,
      hooks.revokeToken,
      hooks.revokeMember,
      toast.success,
      toast.error,
    ])
      mock.mockReset();
  });

  it("saves a kill switch, lifetime cap, and permission ceiling against the loaded revision", async () => {
    const saved = {
      ...OPEN_POLICY,
      enabled: false,
      maxLifetimeDays: 30,
      allowedPermissions: ["sessions.read" as const],
      revision: 4,
    };
    hooks.save.mockResolvedValue({ status: "saved", policy: saved });
    const user = userEvent.setup();
    render(<PersonalAccessTokenAdminSettings />);

    const save = screen.getByRole("button", { name: "Save policy" });
    expect(save).toBeDisabled();
    await user.click(screen.getByRole("switch", { name: "Allow personal access tokens" }));
    await user.click(screen.getByRole("radio", { name: /30 days/ }));
    await selectOnlyCeiling(user);
    await user.click(screen.getByLabelText("Read sessions"));
    await user.click(save);

    expect(hooks.save).toHaveBeenCalledWith(
      { enabled: false, maxLifetimeDays: 30, allowedPermissions: ["sessions.read"] },
      3
    );
    await waitFor(() =>
      expect(hooks.mutatePolicy).toHaveBeenCalledWith(saved, { revalidate: false })
    );
    expect(toast.success).toHaveBeenCalledWith("Access token policy saved");
  });

  it("refuses an empty permission ceiling", async () => {
    const user = userEvent.setup();
    render(<PersonalAccessTokenAdminSettings />);
    await selectOnlyCeiling(user);
    await user.click(screen.getByRole("button", { name: "Save policy" }));
    expect(hooks.save).not.toHaveBeenCalled();
  });

  it("allows a permission's prerequisites with it, and withdraws what needs a withdrawn one", async () => {
    const user = userEvent.setup();
    render(<PersonalAccessTokenAdminSettings />);
    await selectOnlyCeiling(user);

    await user.click(screen.getByLabelText("Manage skills"));
    expect(screen.getByLabelText("Read skills")).toBeChecked();
    await user.click(screen.getByLabelText("Read skills"));
    expect(screen.getByLabelText("Manage skills")).not.toBeChecked();
  });

  it("shows the policy someone else saved rather than overwrite it", async () => {
    hooks.save.mockResolvedValue({ status: "conflict" });
    const user = userEvent.setup();
    render(<PersonalAccessTokenAdminSettings />);

    const enabled = screen.getByRole("switch", { name: "Allow personal access tokens" });
    await user.click(enabled);
    expect(enabled).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save policy" }));

    await waitFor(() => expect(hooks.mutatePolicy).toHaveBeenCalledWith());
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/Someone else changed/));
    // The edit is dropped, so the form shows the reloaded policy and Save is idle again.
    expect(enabled).toBeChecked();
    expect(screen.getByRole("button", { name: "Save policy" })).toBeDisabled();
  });

  it("keeps the form inert while a save is in flight, so no edit is lost", async () => {
    let finish!: (value: unknown) => void;
    hooks.save.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const user = userEvent.setup();
    render(<PersonalAccessTokenAdminSettings />);

    const enabled = screen.getByRole("switch", { name: "Allow personal access tokens" });
    await user.click(enabled);
    await user.click(screen.getByRole("button", { name: "Save policy" }));
    expect(enabled).toBeDisabled();
    expect(screen.getByRole("radio", { name: /30 days/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();

    finish({ status: "saved", policy: { ...OPEN_POLICY, enabled: false, revision: 4 } });
    await waitFor(() => expect(enabled).toBeEnabled());
  });

  it("shows a stored lifetime cap that is not one of the standard choices", () => {
    hooks.policy = { ...OPEN_POLICY, maxLifetimeDays: 45 };
    render(<PersonalAccessTokenAdminSettings />);

    expect(
      screen
        .getAllByRole("radio", { name: /year|days?$/ })
        .map((radio) => radio.closest("label")?.textContent)
    ).toEqual(["1 year", "180 days", "90 days", "45 days", "30 days", "7 days"]);
    expect(screen.getByRole("radio", { name: /45 days/ })).toBeChecked();
  });

  it("saves a draft against the revision it was made from, so a later save is not overwritten", async () => {
    hooks.save.mockResolvedValue({ status: "conflict" });
    const user = userEvent.setup();
    const { rerender } = render(<PersonalAccessTokenAdminSettings />);
    await user.click(screen.getByRole("radio", { name: /90 days/ }));

    // Another administrator turns tokens off; this page revalidates before saving.
    hooks.policy = { ...OPEN_POLICY, enabled: false, revision: 4 };
    rerender(<PersonalAccessTokenAdminSettings />);
    await user.click(screen.getByRole("button", { name: "Save policy" }));

    expect(hooks.save).toHaveBeenCalledWith(
      { enabled: true, maxLifetimeDays: 90, allowedPermissions: null },
      3
    );
  });

  it("keeps unsaved edits when the policy revalidates", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<PersonalAccessTokenAdminSettings />);
    await user.click(screen.getByRole("radio", { name: /90 days/ }));

    hooks.policy = { ...OPEN_POLICY };
    rerender(<PersonalAccessTokenAdminSettings />);
    expect(screen.getByRole("radio", { name: /90 days/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "Save policy" })).toBeEnabled();
  });

  it("guards settings navigation and unload while the policy has unsaved changes", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const navigations: boolean[] = [];
    const user = userEvent.setup();
    render(
      <SettingsNavigationGuardProvider>
        <NavigationProbe onNavigate={(allowed) => navigations.push(allowed)} />
        <PersonalAccessTokenAdminSettings />
      </SettingsNavigationGuardProvider>
    );

    await user.click(screen.getByRole("button", { name: "Other settings" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(unloadPrevented()).toBe(false);

    await user.click(screen.getByRole("switch", { name: "Allow personal access tokens" }));
    await user.click(screen.getByRole("button", { name: "Other settings" }));
    expect(confirm).toHaveBeenCalledWith("Discard unsaved changes?");
    expect(unloadPrevented()).toBe(true);

    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    confirm.mockClear();
    await user.click(screen.getByRole("button", { name: "Other settings" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(unloadPrevented()).toBe(false);
    expect(navigations).toEqual([true, false, true]);
  });

  it("shows when each member's token stops working under the lifetime cap", () => {
    hooks.policy = { ...OPEN_POLICY, maxLifetimeDays: 30 };
    hooks.tokens = [{ ...MEMBER_TOKEN, createdAt: Date.now() - 40 * DAY_MS }];
    render(<PersonalAccessTokenAdminSettings />);

    const list = within(screen.getByRole("list", { name: "Members' access tokens" }));
    expect(list.getByText("Expired")).toBeInTheDocument();
    expect(list.getByText(/^Ada Member · Never used · Expired /)).toBeInTheDocument();
  });

  it("lists members' tokens with their owners and revokes one after confirmation", async () => {
    hooks.tokens = [MEMBER_TOKEN];
    hooks.revokeToken.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<PersonalAccessTokenAdminSettings />);

    const list = within(screen.getByRole("list", { name: "Members' access tokens" }));
    expect(list.getByText("CI reader")).toBeInTheDocument();
    expect(list.getByText(/^Ada Member · Never used/)).toBeInTheDocument();
    await user.click(list.getByRole("button", { name: "Revoke CI reader of Ada Member" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Revoke" })
    );

    await waitFor(() => expect(hooks.revokeToken).toHaveBeenCalledWith("token-1"));
    expect(hooks.mutateTokens).toHaveBeenCalled();
  });

  it("revokes all of a member's tokens after confirmation", async () => {
    hooks.tokens = [MEMBER_TOKEN];
    hooks.revokeMember.mockResolvedValue(2);
    const user = userEvent.setup();
    render(<PersonalAccessTokenAdminSettings />);

    await user.click(screen.getByRole("button", { name: "Revoke all of Ada Member's tokens" }));
    expect(
      within(screen.getByRole("alertdialog")).getByText(/Every token Ada Member holds/)
    ).toBeInTheDocument();
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Revoke" })
    );

    await waitFor(() => expect(hooks.revokeMember).toHaveBeenCalledWith("user-2"));
  });
});
