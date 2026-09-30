// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { BudgetSection } from "./budget-section";
import { toast } from "sonner";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

expect.extend(matchers);

const fetchMock = vi.fn();
vi.mock("@/lib/browser-api-fetch", () => ({
  browserApiFetch: (...args: unknown[]) => fetchMock(...args),
}));

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.clearAllMocks();
});

describe("BudgetSection", () => {
  it("toasts the server reason_code for a denied budget change", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: "Forbidden", reason_code: "team_inactive" }, { status: 403 })
    );
    const user = userEvent.setup();
    render(<BudgetSection sessionId="session-1" totalCost={3} canManageBudget />);
    await user.click(screen.getByRole("button", { name: "Edit limit" }));
    await user.click(screen.getByRole("button", { name: "No limit" }));
    expect(toast.error).toHaveBeenCalledWith(
      "Unable to update the session cost limit (team_inactive)"
    );
  });
  it("shows observed cost and limit with a static reported-usage note", () => {
    render(
      <BudgetSection
        sessionId="session-1"
        totalCost={3.42}
        maxSessionCostUsd={10}
        canManageBudget={false}
      />
    );
    expect(screen.getByText("Session cost: $3.42 of $10.00 limit")).toBeInTheDocument();
    expect(
      screen.getByText("Costs and limits reflect reported model usage only.")
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit limit" })).not.toBeInTheDocument();
  });

  it("lets the owner remove the session limit", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    const user = userEvent.setup();
    render(
      <BudgetSection sessionId="session-1" totalCost={3} maxSessionCostUsd={10} canManageBudget />
    );

    await user.click(screen.getByRole("button", { name: "Edit limit" }));
    await user.click(screen.getByRole("button", { name: "No limit" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/budget", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxCostUsd: null }),
    });
  });
});
