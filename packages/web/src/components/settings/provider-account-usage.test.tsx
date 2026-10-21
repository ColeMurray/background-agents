// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ModelProviderAccount } from "@open-inspect/shared/types/provider-accounts";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { ProviderAccountUsagePanel } from "./provider-account-usage";

const permissions = vi.hoisted(() => new Set(["provider_accounts.read"]));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    hasPermission: (permission: string) => permissions.has(permission),
  }),
}));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));
const account: ModelProviderAccount = {
  id: "1".repeat(32),
  provider: "openai",
  displayName: "Work ChatGPT",
  externalAccountId: "acct-1",
  status: "active",
  createdBy: null,
  updatedBy: null,
  lastVerifiedAt: null,
  lastUsedAt: null,
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
};
const usage = {
  status: "available",
  collectedAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  allowed: true,
  limitReached: false,
  windows: [
    {
      id: "primary",
      usedPercent: 25,
      windowDurationMs: 18_000_000,
      resetsAt: Date.now() + 3600_000,
    },
    {
      id: "secondary",
      usedPercent: 70,
      windowDurationMs: 604_800_000,
      resetsAt: Date.now() + 86400_000,
    },
  ],
};
function wrapper({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>;
}
function renderPanel(value = account) {
  return render(<ProviderAccountUsagePanel account={value} />, { wrapper });
}
beforeEach(() => {
  vi.resetAllMocks();
  permissions.add("provider_accounts.read");
  vi.mocked(browserApiFetch).mockImplementation(async () => Response.json({ usage }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("provider account quota display", () => {
  it("checks the current connection after a reconnect within the deduplication interval", async () => {
    const cache = new Map();
    const panel = (revision: number) => (
      <SWRConfig value={{ provider: () => cache }}>
        <ProviderAccountUsagePanel key={revision} account={{ ...account, updatedAt: revision }} />
      </SWRConfig>
    );
    const view = render(panel(1));
    fireEvent.click(screen.getByRole("button", { name: "Check usage" }));
    expect(await screen.findByText("25% used · 75% remaining")).toBeTruthy();

    vi.mocked(browserApiFetch).mockImplementation(async () =>
      Response.json({ usage: { ...usage, windows: [{ ...usage.windows[0], usedPercent: 5 }] } })
    );
    view.rerender(panel(2));
    expect(screen.queryByText("25% used · 75% remaining")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check usage" }));
    expect(screen.queryByText("25% used · 75% remaining")).toBeNull();
    expect(await screen.findByText("5% used · 95% remaining")).toBeTruthy();
    expect(browserApiFetch).toHaveBeenCalledTimes(2);
  });

  it("fetches after a reset when a newly opened panel checks within the deduplication interval", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const cache = new Map();
    const panel = (visible: boolean) => (
      <SWRConfig value={{ provider: () => cache }}>
        {visible && <ProviderAccountUsagePanel account={account} />}
      </SWRConfig>
    );
    vi.mocked(browserApiFetch).mockImplementation(async () =>
      Response.json({
        usage: {
          ...usage,
          collectedAt: now,
          expiresAt: now + 1000,
          windows: [{ ...usage.windows[0], resetsAt: now + 1000 }],
        },
      })
    );
    const view = render(panel(true));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check usage" }));
    });
    expect(screen.getByText("25% used · 75% remaining")).toBeTruthy();
    view.rerender(panel(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1001);
    });
    vi.mocked(browserApiFetch).mockImplementation(async () =>
      Response.json({
        usage: {
          ...usage,
          collectedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          windows: [{ ...usage.windows[0], usedPercent: 0 }],
        },
      })
    );
    view.rerender(panel(true));
    expect(browserApiFetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check usage" }));
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(browserApiFetch).toHaveBeenCalledTimes(2);
    expect(screen.getByText("0% used · 100% remaining")).toBeTruthy();
  });

  it("marks an open snapshot expired at its reset/cache deadline", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.mocked(browserApiFetch).mockImplementation(async () =>
      Response.json({ usage: { ...usage, collectedAt: now, expiresAt: now + 1000 } })
    );
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check usage" }));
    });
    expect(screen.queryByText(/Snapshot expired/)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1001);
    });
    expect(screen.getByText(/Snapshot expired/)).toBeTruthy();
  });
  it("checks on demand and renders remaining allowance and reset timestamps", async () => {
    renderPanel();
    expect(browserApiFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Check usage" }));
    expect(await screen.findByText("25% used · 75% remaining")).toBeTruthy();
    expect(screen.getByText("70% used · 30% remaining")).toBeTruthy();
    expect(
      screen.getByRole("progressbar", { name: "5-hour window usage" }).getAttribute("value")
    ).toBe("25");
    expect(document.querySelectorAll("time[datetime]")).toHaveLength(3);
    expect(browserApiFetch).toHaveBeenCalledWith(
      `/api/model-provider-accounts/${account.id}/usage`
    );
  });
  it("keeps different accounts' responses separate", async () => {
    vi.mocked(browserApiFetch).mockImplementation(async (path) =>
      Response.json({
        usage: {
          ...usage,
          windows: [{ ...usage.windows[0], usedPercent: path.includes("2222") ? 90 : 25 }],
        },
      })
    );
    render(
      <>
        <ProviderAccountUsagePanel account={account} />
        <ProviderAccountUsagePanel
          account={{ ...account, id: "2".repeat(32), displayName: "Personal" }}
        />
      </>,
      { wrapper }
    );
    for (const button of screen.getAllByRole("button", { name: "Check usage" }))
      fireEvent.click(button);
    expect(await screen.findByText("90% used · 10% remaining")).toBeTruthy();
    expect(screen.getByText("25% used · 75% remaining")).toBeTruthy();
  });
  it.each(["xai", "anthropic"] as const)(
    "shows unsupported for %s without making a request",
    (provider) => {
      renderPanel({ ...account, provider });
      expect(screen.getByText("Usage reporting is not supported for this provider.")).toBeTruthy();
      expect(screen.queryByRole("button")).toBeNull();
      expect(browserApiFetch).not.toHaveBeenCalled();
    }
  );
  it("shows unavailable for disabled accounts", () => {
    renderPanel({ ...account, status: "disabled" });
    expect(screen.getByText(/account is disabled or needs reconnection/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it.each(["timeout", "provider_error", "credentials", "invalid_response", "no_data"])(
    "shows a graceful %s failure",
    async (reason) => {
      vi.mocked(browserApiFetch).mockResolvedValue(
        Response.json({ usage: { status: "unavailable", reason } })
      );
      renderPanel();
      fireEvent.click(screen.getByRole("button", { name: "Check usage" }));
      expect(await screen.findByText(/Usage unavailable\./)).toBeTruthy();
      expect(screen.queryByRole("progressbar")).toBeNull();
    }
  );
  it("handles request errors and allows retry", async () => {
    vi.mocked(browserApiFetch).mockRejectedValueOnce(new Error("fetch failed"));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Check usage" }));
    expect(await screen.findByText("Usage unavailable. Try again later.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
    expect(await screen.findByText("25% used · 75% remaining")).toBeTruthy();
  });
  it("does not fetch without read permission", async () => {
    permissions.clear();
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Check usage" }));
    await waitFor(() => expect(browserApiFetch).not.toHaveBeenCalled());
  });
  it("preserves provider admission independently of percent and labels expired observations", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({
        usage: {
          ...usage,
          allowed: false,
          limitReached: true,
          expiresAt: 1,
          windows: [{ ...usage.windows[0], resetsAt: 1 }],
        },
      })
    );
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Check usage" }));
    expect(await screen.findByText(/currently limited/)).toBeTruthy();
    expect(screen.getByText(/Snapshot expired/)).toBeTruthy();
    expect(screen.getByText(/awaiting provider update/)).toBeTruthy();
    expect(screen.getByText("25% used · 75% remaining")).toBeTruthy();
  });
});
