// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { toast } from "sonner";
import type {
  ModelProviderAccount,
  ModelProviderAccountDefault,
} from "@open-inspect/shared/types/provider-accounts";
import { ProviderAccountsSettings } from "./provider-accounts-settings";
import { CHATGPT_DEVICE_AUTHORIZATION_SETTINGS_URL } from "./provider-device-authorization-dialog";

expect.extend(matchers);
afterEach(cleanup);

const refresh = vi.fn();
const runAction = vi.fn();
const setDefault = vi.fn();
const startAuthorization = vi.fn();
const pollAuthorization = vi.fn();
const cancelAuthorization = vi.fn();
const reconnectAccount = vi.fn();
let legacyCredentialsResult: Record<string, unknown>;
const providers = [
  { provider: "openai" as const, displayName: "OpenAI", subscriptionName: "ChatGPT" },
  { provider: "xai" as const, displayName: "xAI", subscriptionName: "SuperGrok" },
];
const account = {
  id: "a".repeat(32),
  provider: "openai" as const,
  displayName: "Team ChatGPT",
  externalAccountId: "acct_public",
  status: "active" as const,
  createdBy: null,
  updatedBy: null,
  lastVerifiedAt: null,
  lastUsedAt: null,
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
};
let accountsResult: ModelProviderAccount[];
let defaultsResult: ModelProviderAccountDefault[];

vi.mock("@/hooks/use-provider-accounts", () => ({
  useProviderAccounts: () => ({
    providers,
    accounts: accountsResult,
    defaults: defaultsResult,
    loading: false,
    error: undefined,
    refresh,
  }),
  useLegacyProviderCredentials: () => legacyCredentialsResult,
  runProviderAccountAction: (...args: unknown[]) => runAction(...args),
  archiveProviderAccount: vi.fn(),
  connectProviderAccount: vi.fn(),
  reconnectProviderAccount: (...args: unknown[]) => reconnectAccount(...args),
  renameProviderAccount: vi.fn(),
  setProviderAccountDefault: (...args: unknown[]) => setDefault(...args),
  startProviderDeviceAuthorization: (...args: unknown[]) => startAuthorization(...args),
  pollProviderDeviceAuthorization: (...args: unknown[]) => pollAuthorization(...args),
  cancelProviderDeviceAuthorization: (...args: unknown[]) => cancelAuthorization(...args),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe("ProviderAccountsSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refresh.mockResolvedValue(undefined);
    runAction.mockResolvedValue(undefined);
    setDefault.mockResolvedValue(undefined);
    startAuthorization.mockResolvedValue({
      transactionId: "b".repeat(64),
      provider: "openai",
      operation: "create",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device",
      expiresAt: Date.now() + 60_000,
      expiresInMs: 60_000,
      pollIntervalMs: 10_000,
    });
    pollAuthorization.mockImplementation(() => new Promise(() => undefined));
    cancelAuthorization.mockResolvedValue(undefined);
    reconnectAccount.mockResolvedValue(undefined);
    accountsResult = [account];
    defaultsResult = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    legacyCredentialsResult = {
      loading: false,
      legacyKeys: [],
    };
  });

  it("reconnects OpenAI through device authorization with the selected account id", async () => {
    render(<ProviderAccountsSettings />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for Team ChatGPT" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Reconnect" }));

    expect(
      await screen.findByRole("heading", { name: "Reconnect Team ChatGPT" })
    ).toBeInTheDocument();
    expect(startAuthorization).toHaveBeenCalledWith("openai", {
      operation: "reconnect",
      providerAccountId: account.id,
    });
    expect(screen.queryByLabelText("Refresh token")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Account ID")).not.toBeInTheDocument();
  });

  it("starts OpenAI add, renders exact external links, and copies the device code", async () => {
    render(<ProviderAccountsSettings />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Add account" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "ChatGPT" }));

    expect(await screen.findByText("ABCD-EFGH")).toBeInTheDocument();
    expect(startAuthorization).toHaveBeenCalledWith("openai", {
      operation: "create",
      displayName: "ChatGPT account",
    });
    expect(screen.queryByLabelText("Refresh token")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Account ID")).not.toBeInTheDocument();

    const settingsLink = screen.getByRole("link", { name: "Open ChatGPT Settings" });
    const authorizationLink = screen.getByRole("link", { name: "Open Device Authorization" });
    expect(settingsLink).toHaveAttribute("href", CHATGPT_DEVICE_AUTHORIZATION_SETTINGS_URL);
    expect(settingsLink).toHaveAttribute("target", "_blank");
    expect(settingsLink).toHaveAttribute("rel", "noopener noreferrer");
    expect(authorizationLink).toHaveAttribute("href", "https://auth.openai.com/codex/device");
    expect(authorizationLink).toHaveAttribute("target", "_blank");
    expect(authorizationLink).toHaveAttribute("rel", "noopener noreferrer");

    fireEvent.click(screen.getByRole("button", { name: "Copy device code" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("ABCD-EFGH"));
  });

  it("refreshes account state and closes after polling connects", async () => {
    startAuthorization.mockResolvedValue({
      transactionId: "b".repeat(64),
      provider: "openai",
      operation: "create",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device",
      expiresAt: Date.now() + 60_000,
      expiresInMs: 60_000,
      pollIntervalMs: 1,
    });
    pollAuthorization.mockResolvedValue({
      status: "connected",
      account,
      reconnectedExisting: false,
      completedAt: Date.now(),
    });

    render(<ProviderAccountsSettings />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Add account" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "ChatGPT" }));

    await waitFor(() => expect(pollAuthorization).toHaveBeenCalled());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Connect your ChatGPT account" })
      ).not.toBeInTheDocument()
    );
    expect(toast.success).toHaveBeenCalledWith("ChatGPT account connected");
    expect(cancelAuthorization).not.toHaveBeenCalled();
  });

  it("cancels an unfinished authorization when the dialog closes", async () => {
    render(<ProviderAccountsSettings />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Add account" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "ChatGPT" }));
    await screen.findByText("ABCD-EFGH");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(cancelAuthorization).toHaveBeenCalledWith("openai", "b".repeat(64)));
  });

  it("retry starts a fresh authorization request", async () => {
    startAuthorization
      .mockRejectedValueOnce(new Error("OpenAI is temporarily unavailable"))
      .mockResolvedValueOnce({
        transactionId: "c".repeat(64),
        provider: "openai",
        operation: "create",
        userCode: "FRESH-CODE",
        verificationUrl: "https://auth.openai.com/codex/device",
        expiresAt: Date.now() + 60_000,
        expiresInMs: 60_000,
        pollIntervalMs: 10_000,
      });

    render(<ProviderAccountsSettings />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Add account" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "ChatGPT" }));
    expect(await screen.findByText("OpenAI is temporarily unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("FRESH-CODE")).toBeInTheDocument();
    expect(startAuthorization).toHaveBeenCalledTimes(2);
  });

  it("does not offer retry for a permanent start conflict", async () => {
    startAuthorization.mockRejectedValue(
      Object.assign(new Error("Provider account is archived"), {
        status: 409,
        retryable: false,
      })
    );

    render(<ProviderAccountsSettings />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for Team ChatGPT" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Reconnect" }));

    expect(await screen.findByText("Provider account is archived")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("starts SuperGrok device authorization from the provider picker", async () => {
    startAuthorization.mockResolvedValue({
      transactionId: "d".repeat(64),
      provider: "xai",
      operation: "create",
      userCode: "2K5A-5W2T",
      verificationUrl: "https://accounts.x.ai/oauth2/device?user_code=2K5A-5W2T",
      expiresAt: Date.now() + 60_000,
      expiresInMs: 60_000,
      pollIntervalMs: 5_000,
    });
    render(<ProviderAccountsSettings />);

    expect(screen.getByRole("heading", { name: "Connected accounts" })).toBeInTheDocument();
    expect(screen.getByText("Team ChatGPT")).toBeInTheDocument();
    expect(screen.getByText("SuperGrok")).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add account" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "SuperGrok" }));

    expect(
      await screen.findByRole("heading", { name: "Connect your SuperGrok account" })
    ).toBeInTheDocument();
    expect(startAuthorization).toHaveBeenCalledWith("xai", {
      operation: "create",
      displayName: "SuperGrok account",
    });
    expect(screen.queryByLabelText("Refresh token")).not.toBeInTheDocument();
    expect(screen.getByText("2K5A-5W2T")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Device Authorization" })).toHaveAttribute(
      "href",
      "https://accounts.x.ai/oauth2/device?user_code=2K5A-5W2T"
    );
    expect(screen.getByText("Continue in xAI to finish approval.")).toBeInTheDocument();
  });

  it("keeps manual reconnect available for legacy xAI accounts without an identity", async () => {
    const legacyAccount = {
      ...account,
      id: "e".repeat(32),
      provider: "xai" as const,
      displayName: "Legacy SuperGrok",
      externalAccountId: null,
    };
    accountsResult = [legacyAccount];
    render(<ProviderAccountsSettings />);

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "More actions for Legacy SuperGrok" }),
      { button: 0, ctrlKey: false }
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Reconnect" }));
    expect(screen.getByRole("heading", { name: "Reconnect Legacy SuperGrok" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Refresh token"), { target: { value: "legacy-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(reconnectAccount).toHaveBeenCalledWith(legacyAccount.id, {
        provider: "xai",
        refreshToken: "legacy-token",
      })
    );
    expect(startAuthorization).not.toHaveBeenCalled();
  });

  it("keeps the changing countdown outside the live region", async () => {
    render(<ProviderAccountsSettings />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Add account" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "ChatGPT" }));

    expect(await screen.findByText(/expires in/)).toBeInTheDocument();
    const liveRegion = document.querySelector('[aria-live="polite"]');
    expect(liveRegion).toHaveTextContent(
      "Device authorization started. Waiting for authorization."
    );
    expect(liveRegion).not.toHaveTextContent("expires in");
  });

  it("shows an actionable empty state when automated sessions have no default", () => {
    render(<ProviderAccountsSettings />);

    expect(screen.getByRole("heading", { name: "Automated sessions" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Choose credentials for sessions started by automations, bots, or other agents."
      )
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Automated authentication")).not.toBeInTheDocument();
    expect(screen.getAllByText("No default account selected")).toHaveLength(2);
    expect(screen.getAllByText("Choose Make default from an account above.")).toHaveLength(2);
    expect(screen.getAllByTitle("OpenAI")).not.toHaveLength(0);
    expect(screen.getAllByTitle("Grok")).not.toHaveLength(0);
  });

  it("names the effective account used by automated sessions", () => {
    defaultsResult = [
      {
        provider: "openai",
        providerAccountId: account.id,
        unattendedMode: "provider_account",
        createdBy: null,
        updatedBy: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    render(<ProviderAccountsSettings />);

    expect(screen.getByLabelText("Automated authentication")).toHaveTextContent(
      "Use default: Team ChatGPT"
    );
    expect(screen.getByText("Default for automation")).toBeInTheDocument();
  });

  it("does not label the stored account as the automation default in API key mode", () => {
    defaultsResult = [
      {
        provider: "openai",
        providerAccountId: account.id,
        unattendedMode: "api_key",
        createdBy: null,
        updatedBy: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    render(<ProviderAccountsSettings />);

    expect(screen.getByLabelText("Automated authentication")).toHaveTextContent(
      "No account (API key)"
    );
    expect(screen.queryByText("Default for automation")).not.toBeInTheDocument();
  });

  it("sets the provider default from the account row", async () => {
    render(<ProviderAccountsSettings />);

    expect(screen.queryByRole("combobox", { name: "Default account" })).not.toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for Team ChatGPT" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Make default" }));

    await waitFor(() => {
      expect(setDefault).toHaveBeenCalledWith("openai", account.id, "provider_account");
    });
  });

  it("locks every account mutation while an operation is in flight", async () => {
    let finishAction!: () => void;
    runAction.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishAction = resolve;
        })
    );
    accountsResult = [account, { ...account, id: "c".repeat(32), displayName: "Backup ChatGPT" }];
    defaultsResult = [
      {
        provider: "openai",
        providerAccountId: account.id,
        unattendedMode: "provider_account",
        createdBy: null,
        updatedBy: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    render(<ProviderAccountsSettings />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for Team ChatGPT" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Verify" }));

    expect(screen.getByRole("button", { name: "Add account" })).toBeDisabled();
    expect(screen.getAllByLabelText("Automated authentication")[0]).toBeDisabled();
    expect(screen.getByRole("button", { name: "More actions for Backup ChatGPT" })).toBeDisabled();
    expect(runAction).toHaveBeenCalledTimes(1);

    await act(async () => finishAction());
    await waitFor(() => expect(screen.getByRole("button", { name: "Add account" })).toBeEnabled());
  });

  it("shows primary actions only for accounts needing intervention", async () => {
    render(<ProviderAccountsSettings />);

    expect(screen.queryByText(account.externalAccountId)).not.toBeInTheDocument();
    expect(screen.getByText("Verified Never")).toHaveClass("whitespace-nowrap");
    expect(screen.getByText("Used Never")).toHaveClass("whitespace-nowrap");
    expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disable" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Verify" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Rename" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Archive" })).not.toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for Team ChatGPT" }), {
      button: 0,
      ctrlKey: false,
    });

    expect(await screen.findByRole("menuitem", { name: "Make default" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Reconnect" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Verify" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Disable" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Archive" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy account ID" }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(account.externalAccountId)
    );
  });

  it("surfaces reconnect only as the primary action when an account needs attention", async () => {
    accountsResult = [{ ...account, status: "reconnect_required" }];
    render(<ProviderAccountsSettings />);

    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
    expect(
      screen.getByText("This account cannot start new sessions until it is reconnected.")
    ).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for Team ChatGPT" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(await screen.findByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Reconnect" })).not.toBeInTheDocument();
  });

  it("surfaces enable as the primary action when an account is disabled", async () => {
    accountsResult = [{ ...account, status: "disabled" }];
    render(<ProviderAccountsSettings />);

    expect(screen.getByRole("button", { name: "Enable" })).toBeInTheDocument();
    expect(
      screen.getByText("This account is disabled and is not available for new sessions.")
    ).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for Team ChatGPT" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(await screen.findByRole("menuitem", { name: "Reconnect" })).toBeInTheDocument();
  });

  it("confirms disable and runs the lifecycle action", async () => {
    render(<ProviderAccountsSettings />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for Team ChatGPT" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Disable" }));
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));

    await waitFor(() => {
      expect(runAction).toHaveBeenCalledWith(account.id, "disable");
    });
  });

  it("renders exact legacy key locations returned by the backend", () => {
    legacyCredentialsResult = {
      loading: false,
      legacyKeys: [
        { scope: "global", key: "OPENAI_OAUTH_REFRESH_TOKEN" },
        {
          scope: "repository",
          scopeId: "7",
          repository: "acme/repo",
          key: "XAI_OAUTH_ACCESS_TOKEN",
        },
        { scope: "environment", scopeId: "env-1", key: "XAI_OAUTH_REFRESH_TOKEN" },
      ],
      refresh: vi.fn(),
    };

    render(<ProviderAccountsSettings />);

    expect(screen.getByText("Global: OPENAI_OAUTH_REFRESH_TOKEN")).toBeInTheDocument();
    expect(
      screen.getByText("Repository acme/repo (7): XAI_OAUTH_ACCESS_TOKEN")
    ).toBeInTheDocument();
    expect(screen.getByText("Environment env-1: XAI_OAUTH_REFRESH_TOKEN")).toBeInTheDocument();
  });

  it("reports when legacy credential inventory cannot be loaded", () => {
    legacyCredentialsResult = {
      loading: false,
      legacyKeys: [],
      error: new Error("inventory unavailable"),
    };

    render(<ProviderAccountsSettings />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Failed to inspect legacy OAuth credentials."
    );
  });
});
