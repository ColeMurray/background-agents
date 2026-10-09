// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { AccessToken } from "@open-inspect/shared/types/access-tokens";
import { AccessTokensSettings } from "./access-tokens-settings";

expect.extend(matchers);

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  createAccessToken: vi.fn(),
  revokeAccessToken: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-access-tokens", () => ({
  useAccessTokens: () => ({ tokens, loading: false, error: loadError, mutate: mocks.mutate }),
  createAccessToken: mocks.createAccessToken,
  revokeAccessToken: mocks.revokeAccessToken,
}));

let tokens: AccessToken[] = [];
let loadError: Error | undefined;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  tokens = [];
  loadError = undefined;
});

describe("AccessTokensSettings", () => {
  it("shows a token's prefix and never a full token in the list", () => {
    tokens = [
      {
        id: "token-a",
        name: "laptop",
        displayPrefix: "oi_pat_abc123",
        createdAt: Date.now(),
        lastUsedAt: null,
        expiresAt: null,
      },
    ];
    render(<AccessTokensSettings />);

    expect(screen.getByText("laptop")).toBeInTheDocument();
    expect(screen.getByText(/oi_pat_abc123/)).toBeInTheDocument();
    expect(screen.getByText(/Last used never/)).toBeInTheDocument();
  });

  it("reveals the plaintext token once, after creating it", async () => {
    const user = userEvent.setup();
    mocks.createAccessToken.mockResolvedValue({
      id: "token-a",
      name: "laptop",
      displayPrefix: "oi_pat_abc123",
      createdAt: Date.now(),
      lastUsedAt: null,
      expiresAt: null,
      token: "oi_pat_abc123deadbeef",
    });
    render(<AccessTokensSettings />);

    await user.click(screen.getByRole("button", { name: /New Token/ }));
    await user.type(screen.getByLabelText("Name"), "laptop");
    await user.click(screen.getByRole("button", { name: "Create Token" }));

    await waitFor(() => {
      expect(screen.getByText("oi_pat_abc123deadbeef")).toBeInTheDocument();
    });
    expect(mocks.createAccessToken).toHaveBeenCalledWith({ name: "laptop", expiresInDays: 90 });
  });

  it("refuses to create a token with a blank name", async () => {
    const user = userEvent.setup();
    render(<AccessTokensSettings />);

    await user.click(screen.getByRole("button", { name: /New Token/ }));
    await user.click(screen.getByRole("button", { name: "Create Token" }));

    expect(mocks.createAccessToken).not.toHaveBeenCalled();
  });

  it("reports a failed load instead of claiming there are no tokens", async () => {
    // The dangerous confusion: a user with live tokens told they have none,
    // exactly when they may be trying to revoke one.
    loadError = new Error("network");
    render(<AccessTokensSettings />);

    expect(screen.getByText(/Could not load your access tokens/)).toBeInTheDocument();
    expect(screen.queryByText(/No access tokens yet/)).not.toBeInTheDocument();
  });

  it("exposes the selected expiry to assistive technology", async () => {
    const user = userEvent.setup();
    render(<AccessTokensSettings />);
    await user.click(screen.getByRole("button", { name: /New Token/ }));

    const selected = screen.getByRole("radio", { name: "90 days" });
    expect(selected).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "30 days" })).toHaveAttribute("aria-checked", "false");
  });

  it("confirms before revoking, then revokes", async () => {
    const user = userEvent.setup();
    tokens = [
      {
        id: "token-a",
        name: "laptop",
        displayPrefix: "oi_pat_abc123",
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        expiresAt: null,
      },
    ];
    mocks.revokeAccessToken.mockResolvedValue(undefined);
    render(<AccessTokensSettings />);

    await user.click(screen.getByRole("button", { name: "Revoke" }));
    // The list button alone must not revoke; the dialog action does.
    expect(mocks.revokeAccessToken).not.toHaveBeenCalled();

    await user.click(await screen.findByRole("button", { name: "Revoke", hidden: false }));
    await waitFor(() => {
      expect(mocks.revokeAccessToken).toHaveBeenCalledWith("token-a");
    });
  });
});
