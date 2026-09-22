// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { SessionProviderAuthState } from "@open-inspect/shared/types/provider-account-switch";
import { SessionProviderAccount } from "./session-provider-account";
expect.extend(matchers);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const fetchApi = vi.hoisted(() => vi.fn());
const mutate = vi.hoisted(() => vi.fn());
let data: SessionProviderAuthState;
vi.mock("swr", () => ({ default: () => ({ data, mutate }) }));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: fetchApi }));
vi.mock("@/hooks/use-provider-accounts", () => ({ useProviderAccounts: () => ({ accounts: [] }) }));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({ hasPermission: () => true }),
}));
function state(): SessionProviderAuthState {
  return {
    bindings: [
      {
        provider: "openai",
        authMode: "provider_account",
        providerAccountId: "b".repeat(32),
        bindingRevision: 2,
        selectionSource: "explicit",
      },
    ],
    switchAvailable: true,
    pendingCount: 2,
    operation: {
      operationId: "switch",
      provider: "openai",
      sourceAccountId: "a".repeat(32),
      targetAccountId: "b".repeat(32),
      expectedBindingRevision: 1,
      bindingRevision: 2,
      actorId: "actor",
      generation: { sandboxId: "sandbox", createdAt: 1 },
      conversationId: "conversation",
      phase: "applied",
      deadlineMs: 1000,
      hold: true,
      interrupted: true,
    },
  };
}
describe("session provider recovery controls", () => {
  it("requires explicit continuation and sends the operation/revision without replaying a prompt", async () => {
    data = state();
    fetchApi.mockResolvedValue(
      Response.json({ ...data, operation: { ...data.operation, hold: false } })
    );
    render(<SessionProviderAccount sessionId="session" model="openai/gpt-5" canSwitch />);
    expect(fetchApi).not.toHaveBeenCalled();
    expect(screen.getByText(/interrupted prompt will not be replayed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume queued work" }));
    await waitFor(() => expect(fetchApi).toHaveBeenCalledOnce());
    expect(fetchApi.mock.calls[0][0]).toBe("/api/sessions/session/provider-auth/resume");
    expect(JSON.parse(fetchApi.mock.calls[0][1].body)).toEqual({
      operationId: "switch",
      bindingRevision: 2,
    });
  });
  it("viewers can see the hold but cannot release it", () => {
    data = state();
    render(<SessionProviderAccount sessionId="session" model="openai/gpt-5" canSwitch={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("Execution paused");
    expect(screen.queryByRole("button", { name: "Resume queued work" })).toBeNull();
  });
  it("keeps old images unavailable rather than offering a silent fallback", () => {
    data = {
      ...state(),
      operation: null,
      switchAvailable: false,
      unavailableReason: "Unqualified runtime",
    };
    render(<SessionProviderAccount sessionId="session" model="openai/gpt-5" canSwitch />);
    expect(screen.getByRole("button", { name: "Stop and switch" })).toBeDisabled();
    expect(screen.getByText("Unqualified runtime")).toBeInTheDocument();
  });
});
