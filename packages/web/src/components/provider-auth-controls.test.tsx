// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderAuthControls } from "./provider-auth-controls";

expect.extend(matchers);
afterEach(cleanup);

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

describe("ProviderAuthControls menu", () => {
  it("moves provider choices into a compact menu", async () => {
    const onChange = vi.fn();
    render(
      <ProviderAuthControls
        variant="menu"
        provider="openai"
        accounts={[account]}
        value={{ mode: "provider_account", accountId: account.id }}
        onChange={onChange}
      />
    );

    const trigger = screen.getByRole("button", { name: "OpenAI authentication options" });
    expect(trigger).toHaveAttribute("title", "OpenAI authentication");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });

    expect(await screen.findByText("Session options")).toBeInTheDocument();
    const authenticationMenu = screen.getByRole("menuitem", { name: "OpenAI authentication" });
    authenticationMenu.focus();
    fireEvent.keyDown(authenticationMenu, { key: "ArrowRight" });

    expect(await screen.findByRole("menuitemradio", { name: "Team ChatGPT" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect(screen.queryByText(/acct_public/)).not.toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "Use default" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitemradio", { name: "No account" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ mode: "api_key" }));
  });

  it("shows the effective unattended API-key default", () => {
    render(
      <ProviderAuthControls
        provider="openai"
        accounts={[account]}
        defaultValue={{
          provider: "openai",
          providerAccountId: account.id,
          unattendedMode: "api_key",
          createdBy: null,
          updatedBy: null,
          createdAt: 1,
          updatedAt: 1,
        }}
        policyLabel="Use defaults when each run starts"
        unattended
        onChange={vi.fn()}
      />
    );

    expect(screen.getByRole("combobox")).toHaveTextContent(
      "Use defaults when each run starts: No account"
    );
    expect(screen.queryByText(/Use defaults when each run starts: Team ChatGPT/)).toBeNull();
  });
});
