import { beforeEach, describe, expect, it, vi } from "vitest";
import { unstable_serialize } from "swr/infinite";
import { browserApiFetch } from "./browser-api-fetch";
import { isMeTeamsCacheKey } from "./me-teams-cache";
import { buildSessionsPageKey } from "./session-list";
import {
  isSessionScopeCacheKey,
  SessionScopeError,
  subscribeSessionScopeChanges,
  updateSessionScope,
} from "./session-scope";

vi.mock("./browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

describe("scope cache invalidation", () => {
  it.each(
    [
      "/api/sessions",
      buildSessionsPageKey({ teamIds: ["team_source"], offset: 100 }),
      buildSessionsPageKey({ teamIds: ["team_target"] }),
      buildSessionsPageKey({ teamIds: ["team_source", "team_target"], status: "archived" }),
      "/api/sessions/inbox",
      "/api/sessions/inbox?category=finished",
      "/api/sessions/inbox/counts",
      "/api/teams",
      "/api/teams?membership=all",
      "/api/teams/team-id/sessions?cursor=page2",
      ["/api/teams/team-id/sessions?bucket=finished", "viewer"],
      "/api/activity",
      "/api/activity?teamId=old",
      "/api/activity/team-id",
      "/api/audit-events",
      "/api/audit-events?limit=25&cursor=page2",
      "/api/audit-events/team-id",
      unstable_serialize(() => buildSessionsPageKey({ teamIds: ["team_source"] })),
      unstable_serialize(() => "/api/sessions/inbox?category=finished"),
      unstable_serialize(() => "/api/teams/team-id/sessions?cursor=page2"),
      unstable_serialize(() => "/api/activity?teamId=old"),
      unstable_serialize(() => "/api/audit-events?cursor=page2"),
      ["/api/sessions/inbox?category=needs_attention", "cursor", "user"],
      ["/api/sessions/inbox/counts", "viewer"],
      ["/api/activity", "user"],
      ["/api/audit-events?limit=25&cursor=page2", "viewer"],
    ].map((key) => ({ key }))
  )("clears affected discovery cache key $key", ({ key }) => {
    expect(isSessionScopeCacheKey(key)).toBe(true);
  });
  it.each(
    [
      "/api/me/teams",
      "/api/me/teams?membership=all",
      "/api/sessions/",
      "/api/sessions/s1",
      "/api/sessions/s1?includeChildren=true",
      "/api/sessions/s1/children",
      "/api/sessions/s1/sandbox-access",
      "/api/sessions/s1/diff",
      "/api/sessions/s1/skills",
      "/api/sessions/s1/participant-profiles",
      "/api/sessions/s1/collaborator-candidates",
      "/api/sessions/inbox-other",
    ].flatMap((path) => [
      { key: path },
      { key: [path, "viewer"] },
      { key: unstable_serialize(() => path) },
    ])
  )("does not clear membership or per-session cache key $key", ({ key }) => {
    expect(isSessionScopeCacheKey(key)).toBe(false);
  });
  it.each(
    [
      undefined,
      null,
      4,
      {},
      [],
      "/api/members",
      "/api/sessions-other",
      "/api/teams-other",
      "/api/activity-other",
      "/api/audit-events-other",
    ].map((key) => ({ key }))
  )("ignores unrelated key $key", ({ key }) => {
    expect(isSessionScopeCacheKey(key)).toBe(false);
  });

  it.each(
    [
      buildSessionsPageKey({ teamIds: ["team_source"] }),
      "/api/sessions/inbox?category=finished",
      "/api/audit-events?cursor=page2",
    ].map((path) => ({ key: unstable_serialize(() => [path, "viewer"]) }))
  )("does not match unsupported infinite tuple aggregate $key", ({ key }) => {
    expect(isSessionScopeCacheKey(key)).toBe(false);
  });
});

describe("updateSessionScope", () => {
  it("notifies retained-page subscribers only after success and before any refresh", async () => {
    let finishMutation!: (response: Response) => void;
    vi.mocked(browserApiFetch).mockImplementation(
      () => new Promise<Response>((resolve) => (finishMutation = resolve))
    );
    const listener = vi.fn();
    const unsubscribe = subscribeSessionScopeChanges(listener);
    const refresh = vi.fn(async () => {
      expect(listener).toHaveBeenCalledOnce();
    });
    const mutate = vi.fn(async () => {
      expect(listener).toHaveBeenCalledOnce();
      return [];
    });
    try {
      const request = updateSessionScope("/api/sessions/s1/scope", { method: "PUT" }, refresh, {
        mutate,
        cache: new Map(),
      });
      expect(listener).not.toHaveBeenCalled();
      finishMutation(new Response(null, { status: 204 }));
      await request;
      expect(listener).toHaveBeenCalledOnce();
      expect(refresh).toHaveBeenCalledOnce();
      expect(mutate).toHaveBeenCalledTimes(3);
    } finally {
      unsubscribe();
    }
  });

  it("does not notify retained-page subscribers when the mutation fails", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(new Response(null, { status: 403 }));
    const listener = vi.fn();
    const unsubscribe = subscribeSessionScopeChanges(listener);
    try {
      await expect(
        updateSessionScope("/api/sessions/s1/scope", { method: "PUT" }, vi.fn(), {
          mutate: vi.fn(),
          cache: new Map(),
        })
      ).rejects.toThrow("Session update failed (403)");
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("unsubscribes retained-page listeners", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(new Response(null, { status: 204 }));
    const listener = vi.fn();
    const unsubscribe = subscribeSessionScopeChanges(listener);
    unsubscribe();
    await updateSessionScope("/api/sessions/s1/scope", { method: "PUT" }, async () => {}, {
      mutate: vi.fn().mockResolvedValue(undefined),
      cache: new Map(),
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it("awaits snapshot, list, and membership refreshes even when timestamps do not change", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(Response.json({ updatedAt: 1 }));
    let finishSnapshot!: () => void;
    let finishLists!: () => void;
    let finishMembership!: () => void;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSnapshot = resolve;
        })
    );
    const mutate = vi.fn().mockImplementation((key, _data, options) =>
      options?.revalidate === false
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            if (key === isMeTeamsCacheKey) finishMembership = resolve;
            else finishLists = resolve;
          })
    );
    let done = false;
    const request = updateSessionScope(
      "/api/sessions/s1/scope",
      { method: "PUT", body: { teamId: null, includeChildren: true, joinTeam: false } },
      refresh,
      { mutate, cache: new Map() }
    ).then(() => {
      done = true;
    });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(mutate).toHaveBeenCalledWith(isSessionScopeCacheKey, undefined, {
      revalidate: false,
    });
    expect(mutate).toHaveBeenCalledWith(isSessionScopeCacheKey);
    expect(mutate).toHaveBeenCalledWith(isMeTeamsCacheKey);
    expect(mutate).not.toHaveBeenCalledWith(isMeTeamsCacheKey, undefined, {
      revalidate: false,
    });
    finishSnapshot();
    await Promise.resolve();
    expect(done).toBe(false);
    finishLists();
    await Promise.resolve();
    expect(done).toBe(false);
    finishMembership();
    await request;
    expect(done).toBe(true);
  });

  it("clears and revalidates canonical infinite aggregates without reading page metadata", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(new Response(null, { status: 204 }));
    const infiniteKeys = [
      buildSessionsPageKey({ teamIds: ["team_source"] }),
      buildSessionsPageKey({ teamIds: ["team_target"] }),
      "/api/teams/team_source/sessions?cursor=page2",
      "/api/activity?teamId=team_source",
      "/api/audit-events?cursor=page2",
      "/api/sessions/inbox?category=finished",
    ].map((path) => unstable_serialize(() => path));
    const preservedKeys = [
      unstable_serialize(() => "/api/sessions/s1/skills?offset=0"),
      unstable_serialize(() => "/api/repos"),
      unstable_serialize(() => [buildSessionsPageKey({ teamIds: ["team_source"] }), "viewer"]),
    ];
    const cache = new Map(
      [...infiniteKeys, ...preservedKeys].map((key) => [key, { data: [{ version: 1 }] }])
    );
    const readCache = vi.spyOn(cache, "get");
    const mutate = vi.fn().mockResolvedValue(undefined);
    const refresh = vi.fn().mockResolvedValue(undefined);

    await updateSessionScope("/api/sessions/s1/scope", { method: "PUT" }, refresh, {
      mutate,
      cache,
    });

    expect(readCache).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
    for (const key of infiniteKeys) {
      expect(mutate).toHaveBeenCalledWith(key, undefined, { revalidate: false });
      expect(mutate).toHaveBeenCalledWith(key);
    }
    for (const key of preservedKeys) {
      expect(mutate).not.toHaveBeenCalledWith(key, undefined, { revalidate: false });
      expect(mutate).not.toHaveBeenCalledWith(key);
    }
    expect(mutate).toHaveBeenCalledTimes(3 + infiniteKeys.length * 2);
  });

  it("refreshes even for an empty successful response", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(new Response(null, { status: 204 }));
    const refresh = vi.fn().mockResolvedValue(undefined);
    const mutate = vi.fn().mockResolvedValue(undefined);
    await updateSessionScope("/api/sessions/s1/collaborators/user", { method: "DELETE" }, refresh, {
      mutate,
      cache: new Map(),
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(mutate).toHaveBeenCalledTimes(3);
  });

  it("still revalidates lists when snapshot refresh rejects after a successful mutation", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(Response.json({ ok: true }));
    const refresh = vi.fn().mockRejectedValue(new Error("Snapshot unavailable"));
    const mutate = vi.fn().mockResolvedValue(undefined);
    await expect(
      updateSessionScope("/api/sessions/s1/scope", { method: "PUT" }, refresh, {
        mutate,
        cache: new Map(),
      })
    ).rejects.toThrow("Snapshot unavailable");
    expect(mutate).toHaveBeenCalledWith(isSessionScopeCacheKey);
    expect(mutate).toHaveBeenCalledWith(isMeTeamsCacheKey);
  });

  it("reports non-JSON mutation failures without attempting a refresh", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(new Response("Unavailable", { status: 503 }));
    const refresh = vi.fn();
    const mutate = vi.fn();
    await expect(
      updateSessionScope("/api/sessions/s1/scope", { method: "PUT" }, refresh, {
        mutate,
        cache: new Map(),
      })
    ).rejects.toThrow("Session update failed (503)");
    expect(refresh).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it.each([
    [403, { error: "Forbidden", code: "session_action_denied", reason_code: "not_owner" }, true],
    [404, { error: "Session not found" }, true],
    [409, { error: "Denied", code: "descendant_inaccessible" }, true],
    [
      409,
      {
        error: "Missing grant",
        code: "target_team_missing_grant",
        repository: "group/subgroup/repo",
      },
      false,
    ],
    [400, { error: "Owner required", code: "owner_required" }, false],
  ])("retains structured failure %s %j", async (status, body, retryable) => {
    vi.mocked(browserApiFetch).mockResolvedValue(Response.json(body, { status }));
    const refresh = vi.fn();
    const mutate = vi.fn();
    const failure = await updateSessionScope("/api/sessions/s1/scope", { method: "PUT" }, refresh, {
      mutate,
      cache: new Map(),
    }).catch((error) => error);
    expect(failure).toBeInstanceOf(SessionScopeError);
    expect(failure.status).toBe(status);
    expect(failure.canRetryWithoutChildren).toBe(retryable);
    expect(failure.message).toContain(body.error);
    if ("code" in body) expect(failure.message).toContain(body.code);
    if ("reason_code" in body) expect(failure.message).toContain(body.reason_code);
    if ("repository" in body) expect(failure.message).toContain(body.repository);
    expect(refresh).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });
});
