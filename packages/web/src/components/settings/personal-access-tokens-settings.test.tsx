// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { PermissionId } from "@open-inspect/shared/rbac";
import type {
  CreatedPersonalAccessToken,
  PersonalAccessToken,
} from "@open-inspect/shared/types/personal-access-tokens";
import { PersonalAccessTokensSettings } from "./personal-access-tokens-settings";

const hooks = vi.hoisted(() => ({
  tokens: [] as PersonalAccessToken[],
  permissions: [] as PermissionId[],
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
afterEach(cleanup);
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

  it("requires a name and at least one permission before issuing", async () => {
    const user = userEvent.setup();
    render(<PersonalAccessTokensSettings />);
    await user.click(screen.getByRole("button", { name: /New token/ }));

    await user.click(screen.getByRole("button", { name: "Create token" }));
    await user.type(screen.getByLabelText("Name"), "Laptop");
    await user.click(screen.getByRole("button", { name: "Create token" }));

    expect(hooks.issue).not.toHaveBeenCalled();
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
