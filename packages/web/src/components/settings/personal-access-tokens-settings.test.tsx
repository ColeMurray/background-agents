// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { PermissionId } from "@open-inspect/shared/rbac";
import type {
  CreatedPersonalAccessToken,
  PersonalAccessToken,
  PersonalAccessTokenPolicy,
} from "@open-inspect/shared/types/personal-access-tokens";
import { PersonalAccessTokensSettings } from "./personal-access-tokens-settings";
import {
  SettingsNavigationGuardProvider,
  useConfirmSettingsNavigation,
} from "./settings-navigation-guard";

const hooks = vi.hoisted(() => ({
  tokens: [] as PersonalAccessToken[],
  permissions: [] as PermissionId[],
  policy: null as PersonalAccessTokenPolicy | null,
  policyError: undefined as Error | undefined,
  mutate: vi.fn(),
  issue: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock("@/hooks/use-personal-access-tokens", () => ({
  usePersonalAccessTokens: () => ({
    tokens: hooks.tokens,
    loading: false,
    error: undefined,
    mutate: hooks.mutate,
  }),
  usePersonalAccessTokenPolicy: () => ({
    policy: hooks.policy,
    loading: !hooks.policy && !hooks.policyError,
    error: hooks.policyError,
  }),
  issuePersonalAccessToken: hooks.issue,
  revokePersonalAccessToken: hooks.revoke,
}));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    authorization: { permissions: hooks.permissions },
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

expect.extend(matchers);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeAll(() => {
  // jsdom has no ResizeObserver, which the Radix checkbox measures with.
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
const OPEN_POLICY: PersonalAccessTokenPolicy = {
  enabled: true,
  maxLifetimeDays: null,
  allowedPermissions: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/** Stands in for the settings navigation, which asks the guard before changing category. */
function NavigationProbe({ onNavigate }: { onNavigate: (allowed: boolean) => void }) {
  const confirmNavigation = useConfirmSettingsNavigation();
  return (
    <button type="button" onClick={() => onNavigate(confirmNavigation())}>
      Other settings
    </button>
  );
}

function renderInSettings(onNavigate: (allowed: boolean) => void = () => {}) {
  return render(
    <SettingsNavigationGuardProvider>
      <NavigationProbe onNavigate={onNavigate} />
      <PersonalAccessTokensSettings />
    </SettingsNavigationGuardProvider>
  );
}

function unloadPrevented(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
const TOKEN: PersonalAccessToken = {
  id: "token-1",
  name: "Work laptop",
  displayPrefix: "oi_pat_a1b2c3",
  permissions: ["sessions.read", "automations.read"],
  createdAt: Date.now() - DAY_MS,
  lastUsedAt: null,
  expiresAt: Date.now() + 29 * DAY_MS,
};

describe("PersonalAccessTokensSettings", () => {
  beforeEach(() => {
    hooks.tokens = [];
    hooks.policy = OPEN_POLICY;
    hooks.policyError = undefined;
    hooks.permissions = [
      "sessions.read",
      "sessions.create",
      "automations.read",
      "automations.create",
      "global_secrets.manage",
    ];
    hooks.mutate.mockReset();
    hooks.issue.mockReset();
    hooks.revoke.mockReset();
  });

  it("lists tokens with their grant and usage, never a secret", () => {
    hooks.tokens = [TOKEN];
    render(<PersonalAccessTokensSettings />);

    const row = within(screen.getByRole("list", { name: "Access tokens" }));
    expect(row.getByText("Work laptop")).toBeInTheDocument();
    expect(row.getByText("oi_pat_a1b2c3…")).toBeInTheDocument();
    expect(row.getByText(/Never used/)).toBeInTheDocument();
    const grant = within(screen.getByRole("list", { name: "Work laptop permissions" }));
    expect(grant.getByText("Read sessions")).toBeInTheDocument();
    expect(grant.getByText("Read automations")).toBeInTheDocument();
  });

  it.each([
    [Date.now() - 10_000, "Last used just now"],
    [Date.now() - 3 * 60 * 60 * 1000, "Last used 3h ago"],
  ])("describes a last use at %s as %s", (lastUsedAt, label) => {
    hooks.tokens = [{ ...TOKEN, lastUsedAt }];
    render(<PersonalAccessTokensSettings />);
    expect(screen.getByText(new RegExp(label))).toBeInTheDocument();
  });

  it("marks an expired token", () => {
    hooks.tokens = [{ ...TOKEN, expiresAt: Date.now() - DAY_MS }];
    render(<PersonalAccessTokensSettings />);
    expect(screen.getByText("Expired")).toBeInTheDocument();
  });

  it("offers only grantable permissions the user holds", async () => {
    const user = userEvent.setup();
    render(<PersonalAccessTokensSettings />);
    await user.click(screen.getByRole("button", { name: /New token/ }));

    expect(screen.getByLabelText("Read sessions")).toBeInTheDocument();
    expect(screen.getByLabelText("Create automations")).toBeInTheDocument();
    // Held but withheld from tokens, and grantable but not held.
    expect(screen.queryByText(/global secrets/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Manage skills")).not.toBeInTheDocument();
  });

  it("grants skill management only together with reading skills", async () => {
    hooks.permissions = ["skills.read", "skills.manage"];
    const user = userEvent.setup();
    render(<PersonalAccessTokensSettings />);
    await user.click(screen.getByRole("button", { name: /New token/ }));

    await user.click(screen.getByLabelText("Manage skills"));
    expect(screen.getByLabelText("Read skills")).toBeChecked();
    await user.click(screen.getByLabelText("Read skills"));
    expect(screen.getByLabelText("Manage skills")).not.toBeChecked();
  });

  it("does not offer skill management to a user who cannot read skills", async () => {
    hooks.permissions = ["sessions.read", "skills.manage"];
    const user = userEvent.setup();
    render(<PersonalAccessTokensSettings />);
    await user.click(screen.getByRole("button", { name: /New token/ }));
    expect(screen.queryByLabelText("Manage skills")).not.toBeInTheDocument();
  });

  it("issues a token with the chosen grant and shows the secret once", async () => {
    const created: CreatedPersonalAccessToken = {
      ...TOKEN,
      token: `oi_pat_${"a1".repeat(32)}`,
    };
    hooks.issue.mockResolvedValue(created);
    const user = userEvent.setup();
    render(<PersonalAccessTokensSettings />);

    await user.click(screen.getByRole("button", { name: /New token/ }));
    await user.type(screen.getByLabelText("Name"), "  Work laptop ");
    await user.click(screen.getByRole("button", { name: "Read-only" }));
    await user.click(screen.getByLabelText("Create automations"));
    await user.click(screen.getByRole("radio", { name: /90 days/ }));
    await user.click(screen.getByRole("button", { name: "Create token" }));

    expect(hooks.issue).toHaveBeenCalledWith({
      name: "Work laptop",
      expiresInDays: 90,
      permissions: ["sessions.read", "automations.read", "automations.create"],
    });
    const dialog = within(await screen.findByRole("alertdialog"));
    expect(dialog.getByTestId("issued-access-token")).toHaveTextContent(created.token);
    expect(hooks.mutate).toHaveBeenCalled();

    // Escape does not discard the only copy of the secret.
    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.queryByText(created.token)).not.toBeInTheDocument();
  });

  it("says to copy the secret manually when the clipboard is unavailable", async () => {
    hooks.issue.mockResolvedValue({ ...TOKEN, token: `oi_pat_${"d4".repeat(32)}` });
    const user = userEvent.setup();
    // As over plain HTTP: no Clipboard API, and jsdom has no `execCommand` fallback either.
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    render(<PersonalAccessTokensSettings />);

    await user.click(screen.getByRole("button", { name: /New token/ }));
    await user.type(screen.getByLabelText("Name"), "Work laptop");
    await user.click(screen.getByRole("button", { name: "Read-only" }));
    await user.click(screen.getByRole("button", { name: "Create token" }));
    const dialog = within(await screen.findByRole("alertdialog"));
    await user.click(dialog.getByRole("button", { name: "Copy token" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Copy failed; select the token and copy it manually")
    );
  });

  it("keeps a pending issuance from being cancelled or replaced", async () => {
    const pending = deferred<CreatedPersonalAccessToken>();
    hooks.issue.mockReturnValue(pending.promise);
    const user = userEvent.setup();
    render(<PersonalAccessTokensSettings />);

    await user.click(screen.getByRole("button", { name: /New token/ }));
    await user.type(screen.getByLabelText("Name"), "First");
    await user.click(screen.getByLabelText("Read sessions"));
    await user.click(screen.getByRole("button", { name: "Create token" }));

    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Creating..." })).toBeDisabled();
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByLabelText("Read sessions")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /New token/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText("Name")).toHaveValue("First");

    const created = { ...TOKEN, name: "First", token: `oi_pat_${"b2".repeat(32)}` };
    pending.resolve(created);
    const dialog = within(await screen.findByRole("alertdialog"));
    expect(dialog.getByTestId("issued-access-token")).toHaveTextContent(created.token);
    expect(screen.queryByRole("form", { name: "New access token" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New token/ })).not.toBeInTheDocument();

    await user.click(dialog.getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("button", { name: /New token/ })).toBeInTheDocument();
  });

  it("returns a refused issuance to its draft", async () => {
    hooks.issue.mockRejectedValue(new Error("Too many tokens"));
    const user = userEvent.setup();
    render(<PersonalAccessTokensSettings />);

    await user.click(screen.getByRole("button", { name: /New token/ }));
    await user.type(screen.getByLabelText("Name"), "Laptop");
    await user.click(screen.getByLabelText("Read sessions"));
    await user.click(screen.getByRole("button", { name: "Create token" }));

    expect(await screen.findByRole("button", { name: "Create token" })).toBeEnabled();
    expect(screen.getByLabelText("Name")).toHaveValue("Laptop");
    expect(screen.getByLabelText("Read sessions")).toBeChecked();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("guards settings navigation and unload until the new secret is acknowledged", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const navigations: boolean[] = [];
    const pending = deferred<CreatedPersonalAccessToken>();
    hooks.issue.mockReturnValue(pending.promise);
    const user = userEvent.setup();
    renderInSettings((allowed) => navigations.push(allowed));

    // An unsent draft is not guarded.
    await user.click(screen.getByRole("button", { name: /New token/ }));
    await user.type(screen.getByLabelText("Name"), "Laptop");
    await user.click(screen.getByLabelText("Read sessions"));
    await user.click(screen.getByRole("button", { name: "Other settings" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(unloadPrevented()).toBe(false);

    // While the request is pending, leaving would orphan the token's only secret.
    await user.click(screen.getByRole("button", { name: "Create token" }));
    await user.click(screen.getByRole("button", { name: "Other settings" }));
    expect(confirm).toHaveBeenCalledWith("Discard unsaved changes?");
    expect(unloadPrevented()).toBe(true);

    // Likewise while the secret is on screen and unacknowledged.
    pending.resolve({ ...TOKEN, token: `oi_pat_${"c3".repeat(32)}` });
    const dialog = within(await screen.findByRole("alertdialog"));
    confirm.mockClear();
    // The modal secret dialog makes the page behind it inert, so ask the guard directly.
    screen.getByRole("button", { name: "Other settings", hidden: true }).click();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(unloadPrevented()).toBe(true);
    expect(navigations).toEqual([true, false, false]);

    await user.click(dialog.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    confirm.mockClear();
    await user.click(screen.getByRole("button", { name: "Other settings" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(unloadPrevented()).toBe(false);
    expect(navigations.at(-1)).toBe(true);
  });

  it("requires a name and at least one permission before issuing", async () => {
    const user = userEvent.setup();
    render(<PersonalAccessTokensSettings />);
    await user.click(screen.getByRole("button", { name: /New token/ }));

    await user.click(screen.getByRole("button", { name: "Create token" }));
    await user.type(screen.getByLabelText("Name"), "Laptop");
    await user.click(screen.getByRole("button", { name: "Create token" }));

    expect(hooks.issue).not.toHaveBeenCalled();
  });

  it("hides token creation and explains why while the workspace has tokens turned off", () => {
    hooks.policy = { enabled: false, maxLifetimeDays: null, allowedPermissions: null };
    render(<PersonalAccessTokensSettings />);
    expect(screen.queryByRole("button", { name: /New token/ })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/turned personal access tokens off/);
  });

  it("offers only lifetimes and permissions the workspace policy allows", async () => {
    hooks.policy = { enabled: true, maxLifetimeDays: 45, allowedPermissions: ["sessions.read"] };
    const user = userEvent.setup();
    render(<PersonalAccessTokensSettings />);
    await user.click(screen.getByRole("button", { name: /New token/ }));

    expect(
      screen.getAllByRole("radio").map((radio) => radio.closest("label")?.textContent)
    ).toEqual(["7 days", "30 days", "45 days"]);
    expect(screen.getByLabelText("Read sessions")).toBeInTheDocument();
    expect(screen.queryByLabelText("Create automations")).not.toBeInTheDocument();
  });

  it("does not offer skill management when the policy withholds reading skills", async () => {
    hooks.permissions = ["sessions.read", "skills.read", "skills.manage"];
    hooks.policy = {
      enabled: true,
      maxLifetimeDays: null,
      allowedPermissions: ["sessions.read", "skills.manage"],
    };
    const user = userEvent.setup();
    render(<PersonalAccessTokensSettings />);
    await user.click(screen.getByRole("button", { name: /New token/ }));

    expect(screen.getByLabelText("Read sessions")).toBeInTheDocument();
    expect(screen.queryByLabelText("Read skills")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Manage skills")).not.toBeInTheDocument();
  });

  it("offers no new token until the workspace policy has loaded", () => {
    hooks.policy = null;
    render(<PersonalAccessTokensSettings />);
    expect(screen.queryByRole("button", { name: /New token/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("explains that new tokens wait on a policy that failed to load", () => {
    hooks.policy = null;
    hooks.policyError = new Error("unavailable");
    render(<PersonalAccessTokensSettings />);
    expect(screen.queryByRole("button", { name: /New token/ })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/token policy/);
  });

  it("holds an open draft to a lifetime cap that arrives while it is being edited", async () => {
    hooks.issue.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    const { rerender } = render(<PersonalAccessTokensSettings />);
    await user.click(screen.getByRole("button", { name: /New token/ }));
    expect(screen.getByRole("radio", { name: /30 days/ })).toBeChecked();
    await user.type(screen.getByLabelText("Name"), "Laptop");
    await user.click(screen.getByLabelText("Read sessions"));

    hooks.policy = { ...OPEN_POLICY, maxLifetimeDays: 7 };
    rerender(<PersonalAccessTokensSettings />);
    expect(screen.getByRole("radio", { name: /7 days/ })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Create token" }));
    expect(hooks.issue).toHaveBeenCalledWith({
      name: "Laptop",
      expiresInDays: 7,
      permissions: ["sessions.read"],
    });
  });

  it("shows the expiry the policy's lifetime cap imposes", () => {
    hooks.tokens = [{ ...TOKEN, createdAt: Date.now() - 40 * DAY_MS }];
    hooks.policy = { enabled: true, maxLifetimeDays: 30, allowedPermissions: null };
    render(<PersonalAccessTokensSettings />);
    expect(screen.getByText("Expired")).toBeInTheDocument();
  });

  it("revokes a token after confirmation", async () => {
    hooks.tokens = [TOKEN];
    hooks.revoke.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<PersonalAccessTokensSettings />);

    await user.click(screen.getByRole("button", { name: "Revoke Work laptop" }));
    expect(hooks.revoke).not.toHaveBeenCalled();
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Revoke" })
    );

    await waitFor(() => expect(hooks.revoke).toHaveBeenCalledWith("token-1"));
    expect(hooks.mutate).toHaveBeenCalled();
  });
});
