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

    const trigger = screen.getByRole("button", {
      name: "OpenAI authentication options, Team ChatGPT",
    });
    expect(trigger).toHaveAttribute("title", "OpenAI authentication");
    expect(screen.getByTitle("OpenAI")).toBeInTheDocument();
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

  it("uses the Grok logo for xAI authentication", () => {
    render(
      <ProviderAuthControls
        variant="menu"
        provider="xai"
        accounts={[{ ...account, provider: "xai", displayName: "SuperGrok" }]}
        value={{ mode: "provider_account", accountId: account.id }}
        onChange={vi.fn()}
      />
    );

    expect(
      screen.getByRole("button", {
        name: "xAI authentication options, SuperGrok",
      })
    ).toBeInTheDocument();
    expect(screen.getByTitle("Grok")).toBeInTheDocument();
  });

  it("keeps the effective default in the compact trigger's accessible label", () => {
    render(
      <ProviderAuthControls
        variant="menu"
        provider="openai"
        accounts={[account]}
        defaultValue={{
          provider: "openai",
          providerAccountId: account.id,
          unattendedMode: "provider_account",
          createdBy: null,
          updatedBy: null,
          createdAt: 1,
          updatedAt: 1,
        }}
        onChange={vi.fn()}
      />
    );

    expect(
      screen.getByRole("button", {
        name: "OpenAI authentication options, Team ChatGPT",
      })
    ).toBeInTheDocument();
    expect(screen.getByTitle("OpenAI")).toBeInTheDocument();
  });

  it("identifies an unavailable default account in the compact trigger's accessible label", () => {
    render(
      <ProviderAuthControls
        variant="menu"
        provider="openai"
        accounts={[{ ...account, status: "reconnect_required" }]}
        defaultValue={{
          provider: "openai",
          providerAccountId: account.id,
          unattendedMode: "provider_account",
          createdBy: null,
          updatedBy: null,
          createdAt: 1,
          updatedAt: 1,
        }}
        onChange={vi.fn()}
      />
    );

    expect(
      screen.getByRole("button", {
        name: "OpenAI authentication options, Unavailable account",
      })
    ).toBeInTheDocument();
    expect(screen.getByTitle("OpenAI")).toBeInTheDocument();
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

  it("labels an unavailable account in the standard selector", () => {
    render(
      <ProviderAuthControls
        provider="openai"
        accounts={[]}
        value={{ mode: "provider_account", accountId: account.id }}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByRole("combobox")).toHaveTextContent("Unavailable account");
  });

  it("disables both control variants while the owning form is locked", () => {
    const { rerender } = render(
      <ProviderAuthControls
        variant="menu"
        provider="openai"
        accounts={[account]}
        disabled
        onChange={vi.fn()}
      />
    );
    expect(
      screen.getByRole("button", { name: "OpenAI authentication options, Use default" })
    ).toBeDisabled();

    rerender(
      <ProviderAuthControls provider="openai" accounts={[account]} disabled onChange={vi.fn()} />
    );
    expect(screen.getByRole("combobox")).toBeDisabled();
  });

  it("blocks an already-open menu when the owning form becomes locked", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ProviderAuthControls
        variant="menu"
        provider="openai"
        accounts={[account]}
        onChange={onChange}
      />
    );
    const trigger = screen.getByRole("button", {
      name: "OpenAI authentication options, Use default",
    });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    const authenticationMenu = await screen.findByRole("menuitem", {
      name: "OpenAI authentication",
    });
    authenticationMenu.focus();
    fireEvent.keyDown(authenticationMenu, { key: "ArrowRight" });
    const noAccount = await screen.findByRole("menuitemradio", { name: "No account" });

    rerender(
      <ProviderAuthControls
        variant="menu"
        provider="openai"
        accounts={[account]}
        disabled
        onChange={onChange}
      />
    );

    expect(noAccount).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(noAccount);
    expect(onChange).not.toHaveBeenCalled();
  });
});
