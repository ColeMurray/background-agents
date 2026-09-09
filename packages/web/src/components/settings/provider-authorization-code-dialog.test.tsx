// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import {
  ANTHROPIC_CREDENTIAL_ROTATION_WARNING,
  ProviderAuthorizationCodeDialog,
} from "./provider-authorization-code-dialog";

expect.extend(matchers);
afterEach(cleanup);

const startAuthorization = vi.fn();
const completeAuthorization = vi.fn();
const cancelAuthorization = vi.fn();

vi.mock("@/hooks/use-provider-accounts", () => ({
  startProviderAuthorizationCode: (...args: unknown[]) => startAuthorization(...args),
  completeProviderAuthorizationCode: (...args: unknown[]) => completeAuthorization(...args),
  cancelProviderAuthorizationCode: (...args: unknown[]) => cancelAuthorization(...args),
}));

const transactionId = "f".repeat(64);
const authorizationUrl = "https://claude.ai/oauth/authorize?state=abc";
const started = {
  transactionId,
  provider: "anthropic" as const,
  operation: "create" as const,
  authorizationUrl,
  expiresAt: Date.now() + 60_000,
  expiresInMs: 60_000,
};
const connected = {
  status: "connected" as const,
  account: {
    id: "a".repeat(32),
    provider: "anthropic" as const,
    displayName: "Claude account",
    externalAccountId: null,
    status: "active" as const,
    createdBy: null,
    updatedBy: null,
    lastVerifiedAt: null,
    lastUsedAt: null,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
  },
  reconnectedExisting: false,
  completedAt: Date.now(),
};
const reconnectStarted = { ...started, operation: "reconnect" as const };
const createTarget = { provider: "anthropic" as const, operation: "create" as const };
const reconnectTarget = {
  provider: "anthropic" as const,
  operation: "reconnect" as const,
  providerAccountId: "e".repeat(32),
  displayName: "Team Claude",
};

function renderDialog(
  overrides: Partial<Parameters<typeof ProviderAuthorizationCodeDialog>[0]> = {}
) {
  const props = {
    target: createTarget,
    saving: false,
    onConnected: vi.fn(),
    onSubmitSetupToken: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<ProviderAuthorizationCodeDialog {...props} />);
  return props;
}

describe("ProviderAuthorizationCodeDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startAuthorization.mockResolvedValue(started);
    completeAuthorization.mockImplementation(() => new Promise(() => undefined));
    cancelAuthorization.mockResolvedValue(undefined);
  });

  it("opens Anthropic in a new tab and completes with the pasted code", async () => {
    completeAuthorization.mockResolvedValue(connected);
    const { onConnected } = renderDialog();

    expect(
      screen.getByRole("heading", { name: "Connect your Claude account" })
    ).toBeInTheDocument();
    expect(startAuthorization).toHaveBeenCalledWith("anthropic", {
      operation: "create",
      displayName: "Claude account",
    });
    const link = await screen.findByRole("link", { name: "Open Anthropic" });
    expect(link).toHaveAttribute("href", authorizationUrl);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText(/expires in/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Complete" })).toBeDisabled();
    expect(document.body.textContent).not.toMatch(/Claude Code/);

    fireEvent.change(screen.getByLabelText("Authorization code"), {
      target: { value: " code#state " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Complete" }));

    await waitFor(() =>
      expect(completeAuthorization).toHaveBeenCalledWith("anthropic", transactionId, "code#state")
    );
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(connected));
    expect(cancelAuthorization).not.toHaveBeenCalled();
  });

  it("shows a rejected code inline and lets the user paste again", async () => {
    completeAuthorization.mockRejectedValueOnce(
      Object.assign(new Error("Invalid authorization code"), { status: 400 })
    );
    renderDialog();
    await screen.findByRole("link", { name: "Open Anthropic" });

    fireEvent.change(screen.getByLabelText("Authorization code"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Complete" }));

    expect(await screen.findByText("Invalid authorization code")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Complete" })).toBeEnabled();
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent(
      "Authorization failed: Invalid authorization code"
    );
    expect(startAuthorization).toHaveBeenCalledOnce();
  });

  it("retry starts a fresh transaction after a retryable start failure", async () => {
    startAuthorization
      .mockRejectedValueOnce(new Error("Anthropic is temporarily unavailable"))
      .mockResolvedValueOnce({ ...started, transactionId: "e".repeat(64) });
    renderDialog();

    expect(await screen.findByText("Anthropic is temporarily unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("link", { name: "Open Anthropic" })).toBeInTheDocument();
    expect(startAuthorization).toHaveBeenCalledTimes(2);
  });

  it("warns that reconnecting rotates the stored token", async () => {
    startAuthorization.mockResolvedValue(reconnectStarted);
    renderDialog({ target: reconnectTarget });

    expect(screen.getByRole("heading", { name: "Reconnect Team Claude" })).toBeInTheDocument();
    expect(screen.getByText(ANTHROPIC_CREDENTIAL_ROTATION_WARNING)).toBeInTheDocument();
    await waitFor(() =>
      expect(startAuthorization).toHaveBeenCalledWith("anthropic", {
        operation: "reconnect",
        providerAccountId: reconnectTarget.providerAccountId,
      })
    );
  });

  it("submits a new account from a pasted setup token", async () => {
    const { onSubmitSetupToken } = renderDialog();
    await screen.findByRole("link", { name: "Open Anthropic" });

    fireEvent.click(screen.getByRole("button", { name: "Paste a setup token instead" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Account name"), { target: { value: " Team Claude " } });
    fireEvent.change(screen.getByLabelText("Setup token"), {
      target: { value: "sk-ant-oat01-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmitSetupToken).toHaveBeenCalledWith({
      operation: "create",
      displayName: "Team Claude",
      setupToken: "sk-ant-oat01-token",
    });
    expect(completeAuthorization).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("link", { name: "Open Anthropic" })).toBeInTheDocument();
  });

  it("submits a reconnect setup token against the explicit account", async () => {
    startAuthorization.mockResolvedValue(reconnectStarted);
    const { onSubmitSetupToken } = renderDialog({ target: reconnectTarget });
    await screen.findByRole("link", { name: "Open Anthropic" });

    fireEvent.click(screen.getByRole("button", { name: "Paste a setup token instead" }));
    expect(screen.queryByLabelText("Account name")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Setup token"), {
      target: { value: "sk-ant-oat01-rotated" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmitSetupToken).toHaveBeenCalledWith({
      operation: "reconnect",
      providerAccountId: reconnectTarget.providerAccountId,
      setupToken: "sk-ant-oat01-rotated",
    });
  });

  it("disables the setup token form while a save is in flight", async () => {
    renderDialog({ saving: true });
    await screen.findByRole("link", { name: "Open Anthropic" });

    fireEvent.click(screen.getByRole("button", { name: "Paste a setup token instead" }));
    fireEvent.change(screen.getByLabelText("Setup token"), { target: { value: "token" } });

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("cancels the unfinished transaction when closed", async () => {
    const { onClose } = renderDialog();
    await screen.findByRole("link", { name: "Open Anthropic" });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(cancelAuthorization).toHaveBeenCalledWith("anthropic", transactionId)
    );
  });
});
