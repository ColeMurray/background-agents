// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { ModelProviderAccount } from "@open-inspect/shared/types/provider-accounts";
import type { ProviderAccountRouting } from "@open-inspect/shared/types/provider-account-routing";
import { setProviderAccountRouting } from "@/hooks/use-provider-accounts";
import { ProviderAccountRoutingSettings } from "./provider-account-routing-settings";

vi.mock("@/hooks/use-provider-accounts", () => ({ setProviderAccountRouting: vi.fn() }));
expect.extend(matchers);
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const active: ModelProviderAccount = {
  id: "a".repeat(32),
  provider: "openai",
  displayName: "Active account",
  status: "active",
  externalAccountId: null,
  createdBy: null,
  updatedBy: null,
  lastVerifiedAt: null,
  lastUsedAt: null,
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
};
const unavailableId = "b".repeat(32);
const policy: ProviderAccountRouting = {
  provider: "openai",
  policyRevision: 7,
  unattendedMode: "provider_account",
  selection: { mode: "random", accountIds: [active.id, unavailableId] },
};

describe("random account pool repair", () => {
  it.each(["disabled", "reconnect_required", "archived", "missing"] as const)(
    "allows removal of a selected %s member without permitting it to be added",
    async (status) => {
      const unavailable: ModelProviderAccount = {
        ...active,
        id: unavailableId,
        displayName: "Unavailable member",
        status: status === "disabled" || status === "reconnect_required" ? status : "active",
        archivedAt: status === "archived" ? 2 : null,
      };
      const refresh = vi.fn(async () => {});
      render(
        <ProviderAccountRoutingSettings
          policy={policy}
          accounts={status === "missing" ? [active] : [active, unavailable]}
          canManage
          refresh={refresh}
        />
      );
      const member = screen.getByRole("checkbox", { name: /Unavailable/ });
      expect(member).toBeChecked();
      expect(member).toBeEnabled();
      fireEvent.click(member);
      const remaining = screen.queryByRole("checkbox", { name: /Unavailable/ });
      if (remaining) {
        expect(remaining).not.toBeChecked();
        expect(remaining).toBeDisabled();
      }
      fireEvent.click(screen.getByRole("button", { name: "Save selection policy" }));
      await waitFor(() =>
        expect(setProviderAccountRouting).toHaveBeenCalledWith("openai", {
          expectedPolicyRevision: 7,
          unattendedMode: "provider_account",
          selection: { mode: "random", accountIds: [active.id] },
        })
      );
      await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    }
  );

  it("keeps unavailable member removal read-only without management permission", () => {
    render(
      <ProviderAccountRoutingSettings
        policy={policy}
        accounts={[active]}
        canManage={false}
        refresh={vi.fn()}
      />
    );
    expect(screen.getByRole("checkbox", { name: /Unavailable/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save selection policy" })).toBeDisabled();
  });
});
