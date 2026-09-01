// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { AUDIT_EVENT_PAGE_SIZE, auditEventsKey, useAuditEvents } from "./use-audit-events";

vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));

const event = {
  id: "event-1",
  occurredAt: 1_700_000_000_000,
  requestId: "request-1",
  principalKind: "user" as const,
  actorUserIdSnapshot: "user-1",
  actorServiceSnapshot: null,
  action: "workspace.member_role_updated",
  resourceType: "user",
  resourceId: "user-2",
  targetUserIdSnapshot: "user-2",
  reasonCode: "member_role_updated",
  operationResult: "applied" as const,
  metadata: {},
};

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
  );
}

describe("useAuditEvents", () => {
  beforeEach(() => vi.resetAllMocks());

  it("uses a page-size-25 key and encodes opaque cursors", () => {
    expect(AUDIT_EVENT_PAGE_SIZE).toBe(25);
    expect(auditEventsKey()).toBe("/api/audit-events?limit=25");
    expect(auditEventsKey("v1.cursor/+ value")).toBe(
      "/api/audit-events?limit=25&cursor=v1.cursor%2F%2B+value"
    );
  });

  it("validates pages and navigates through cursor history", async () => {
    vi.mocked(browserApiFetch)
      .mockResolvedValueOnce(
        Response.json({ events: [event], hasMore: true, nextCursor: "cursor-2" })
      )
      .mockResolvedValueOnce(
        Response.json({ events: [{ ...event, id: "event-2" }], hasMore: false, nextCursor: null })
      );
    const { result } = renderHook(useAuditEvents, { wrapper });

    await waitFor(() => expect(result.current.events[0]?.id).toBe("event-1"));
    expect(browserApiFetch).toHaveBeenCalledWith("/api/audit-events?limit=25");

    act(() => result.current.next());
    await waitFor(() => expect(result.current.events[0]?.id).toBe("event-2"));
    expect(result.current.page).toBe(2);
    expect(result.current.hasPrevious).toBe(true);
    expect(browserApiFetch).toHaveBeenCalledWith("/api/audit-events?limit=25&cursor=cursor-2");

    act(() => result.current.previous());
    await waitFor(() => expect(result.current.events[0]?.id).toBe("event-1"));
    expect(result.current.page).toBe(1);
    expect(browserApiFetch).toHaveBeenCalledTimes(2);
  });

  it("surfaces invalid shared-contract responses as errors", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({ events: [], hasMore: true, nextCursor: null })
    );
    const { result } = renderHook(useAuditEvents, { wrapper });

    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect(result.current.error).toMatchObject({ message: "Invalid audit log response" });
  });
});
