// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { useAuthSession } from "@/lib/auth-session";
import { AUDIT_EVENT_PAGE_SIZE, auditEventsKey, useAuditEvents } from "./use-audit-events";

vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));
vi.mock("@/lib/auth-session", () => ({ useAuthSession: vi.fn() }));

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
    <SWRConfig
      value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}
    >
      {children}
    </SWRConfig>
  );
}

describe("useAuditEvents", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: "user_one", name: "Viewer", email: "viewer@example.com", image: null } },
      status: "authenticated",
    });
  });

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

  it("encodes the team filter", () => {
    expect(auditEventsKey(undefined, { teamId: "team/one" })).toBe(
      "/api/audit-events?limit=25&teamId=team%2Fone"
    );
  });

  it("resets cursor history immediately when the team filter changes", async () => {
    vi.mocked(browserApiFetch).mockImplementation(async () =>
      Response.json({ events: [event], hasMore: true, nextCursor: "page-two" })
    );
    const { result, rerender } = renderHook(({ teamId }) => useAuditEvents({ teamId }), {
      wrapper,
      initialProps: { teamId: "team_one" },
    });
    await waitFor(() => expect(result.current.hasNext).toBe(true));
    act(() => result.current.next());
    await waitFor(() => expect(result.current.page).toBe(2));
    rerender({ teamId: "team_two" });
    await waitFor(() =>
      expect(browserApiFetch).toHaveBeenCalledWith("/api/audit-events?limit=25&teamId=team_two")
    );
    expect(result.current.page).toBe(1);
    expect(result.current.hasPrevious).toBe(false);
    expect(browserApiFetch).not.toHaveBeenCalledWith(
      expect.stringContaining("cursor=page-two&teamId=team_two")
    );
  });

  it("isolates cached events and resets cursors when the viewer changes in the same provider", async () => {
    let userId = "user_one";
    vi.mocked(useAuthSession).mockImplementation(() => ({
      data: { user: { id: userId, name: "Viewer", email: "viewer@example.com", image: null } },
      status: "authenticated",
    }));
    let resolveNewUser!: (response: Response) => void;
    const newUserResponse = new Promise<Response>((resolve) => {
      resolveNewUser = resolve;
    });
    vi.mocked(browserApiFetch).mockImplementation(async (path) => {
      if (userId === "user_two") return newUserResponse;
      return Response.json({
        events: [
          {
            ...event,
            id: path.includes("cursor=") ? "user_one_page_two" : "user_one_page_one",
          },
        ],
        hasMore: true,
        nextCursor: "user_one_cursor",
      });
    });
    const { result, rerender } = renderHook(useAuditEvents, { wrapper });
    await waitFor(() => expect(result.current.events[0]?.id).toBe("user_one_page_one"));
    act(() => result.current.next());
    await waitFor(() => expect(result.current.events[0]?.id).toBe("user_one_page_two"));

    vi.mocked(browserApiFetch).mockClear();
    userId = "user_two";
    rerender();
    expect(result.current.events).toEqual([]);
    expect(result.current.page).toBe(1);
    expect(result.current.hasPrevious).toBe(false);
    await waitFor(() => expect(browserApiFetch).toHaveBeenCalledWith(auditEventsKey()));
    expect(browserApiFetch).not.toHaveBeenCalledWith(expect.stringContaining("cursor="));
    await act(async () => {
      resolveNewUser(
        Response.json({
          events: [{ ...event, id: "user_two_row" }],
          hasMore: false,
          nextCursor: null,
        })
      );
    });
    await waitFor(() => expect(result.current.events[0]?.id).toBe("user_two_row"));

    vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "unauthenticated" });
    vi.mocked(browserApiFetch).mockClear();
    rerender();
    expect(result.current.events).toEqual([]);
    expect(result.current.page).toBe(1);
    expect(browserApiFetch).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 500])(
    "withholds cached events on access denial but retains them on transient failure (%s)",
    async (failureStatus) => {
      let status = 200;
      vi.mocked(browserApiFetch).mockImplementation(async () =>
        Response.json(
          status === 200
            ? { events: [event], hasMore: true, nextCursor: "next_page" }
            : { error: "failed" },
          { status }
        )
      );
      const { result } = renderHook(useAuditEvents, { wrapper });
      await waitFor(() => expect(result.current.events).toHaveLength(1));
      status = failureStatus;
      await act(async () => {
        await result.current.retry();
      });
      await waitFor(() => expect(result.current.error).toMatchObject({ status: failureStatus }));
      expect(result.current.events.map(({ id }) => id)).toEqual(
        failureStatus === 500 ? [event.id] : []
      );
      expect(result.current.hasNext).toBe(failureStatus === 500);
    }
  );

  it("does not fetch workspace audit events while disabled", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({ events: [], hasMore: false, nextCursor: null })
    );
    const { rerender } = renderHook(({ enabled }) => useAuditEvents({ enabled }), {
      wrapper,
      initialProps: { enabled: false },
    });
    expect(browserApiFetch).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(browserApiFetch).toHaveBeenCalledWith("/api/audit-events?limit=25"));
  });
});
