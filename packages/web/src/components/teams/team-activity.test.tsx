// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamActivity } from "./team-activity";

expect.extend(matchers);
const useAuditEvents = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-audit-events", () => ({ useAuditEvents }));
afterEach(cleanup);

describe("Team activity", () => {
  it("reuses audit labels, renders newest-first pages, and sends the action filter to the team endpoint", () => {
    const event = {
      id: "newest",
      occurredAt: 2_000,
      requestId: "request",
      principalKind: "user",
      actorUserIdSnapshot: "user",
      actorServiceSnapshot: null,
      action: "team.member_joined",
      resourceType: "team",
      resourceId: "team_one",
      targetUserIdSnapshot: null,
      reasonCode: "joined",
      operationResult: "applied",
      metadata: {},
    };
    const next = vi.fn();
    useAuditEvents.mockReturnValue({
      events: [event, { ...event, id: "older", occurredAt: 1_000, action: "session.moved" }],
      loading: false,
      validating: false,
      error: null,
      page: 1,
      hasPrevious: false,
      hasNext: true,
      next,
      previous: vi.fn(),
      retry: vi.fn(),
    });
    render(<TeamActivity teamId="team_one" />);
    const cards = screen.getAllByRole("article");
    expect(within(cards[0]).getByText("Team member joined")).toBeInTheDocument();
    expect(within(cards[1]).getByText("Session moved")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Event type" }), {
      target: { value: "session.moved" },
    });
    expect(useAuditEvents).toHaveBeenLastCalledWith({
      endpoint: "/api/teams/team_one/activity",
      action: "session.moved",
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(next).toHaveBeenCalledOnce();
  });
});
