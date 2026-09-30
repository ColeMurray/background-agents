import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { SessionViewer } from "@open-inspect/shared";
import { SessionIndexStore } from "../../src/db/session-index";
import { SessionInboxStore } from "../../src/db/session-inbox-store";
import { SessionCollaboratorStore } from "../../src/db/session-collaborators";
import { cleanD1Tables } from "./cleanup";
import { seedActiveUser, serviceFetch } from "./helpers";
import { VIEWER_ID, viewer, seedTeams, session } from "./session-inbox-test-helpers";

describe("scoped inbox", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedTeams();
    const otherUserId = "22222222222222222222222222222222";
    await seedActiveUser(otherUserId);
    const store = new SessionIndexStore(env.DB);
    await store.create(
      session("team-root", {
        ownerTeamId: "team-a",
        visibility: "team",
        updatedAt: 7000,
      })
    );
    await store.create(session("workspace-root", { userId: otherUserId, updatedAt: 6000 }));
    await store.create(
      session("owned-child", {
        parentSessionId: "workspace-root",
        spawnDepth: 1,
        ownerTeamId: "team-a",
        visibility: "team",
        updatedAt: 5000,
      })
    );
    await store.create(
      session("collaborating", {
        userId: otherUserId,
        visibility: "private",
        updatedAt: 4000,
      })
    );
    await store.create(session("read-only", { userId: otherUserId, updatedAt: 3000 }));
    await store.create(
      session("unrelated", {
        userId: otherUserId,
        status: "active",
        updatedAt: 2000,
      })
    );
    await store.create(
      session("hidden", {
        userId: otherUserId,
        visibility: "private",
        status: "active",
        updatedAt: 8000,
      })
    );
    await store.create(session("owned-private", { visibility: "private", updatedAt: 1000 }));
    await new SessionCollaboratorStore(env.DB).add("collaborating", VIEWER_ID, otherUserId);
    for (const sessionId of ["read-only", "hidden"]) {
      await env.DB.prepare(
        "INSERT INTO session_read_states (user_id, session_id, last_read_message_id, updated_at) VALUES (?, ?, 'read-message', 1)"
      )
        .bind(VIEWER_ID, sessionId)
        .run();
    }
  });

  it.each([
    { ownerFilter: "started" as const, ids: ["team-root", "owned-child", "owned-private"] },
    {
      ownerFilter: "participating" as const,
      ids: ["team-root", "owned-child", "collaborating", "read-only", "owned-private"],
    },
    {
      ownerFilter: "anyone" as const,
      ids: ["team-root", "workspace-root", "collaborating", "read-only", "owned-private"],
    },
  ])(
    "applies $ownerFilter before rerooting, classification and pagination",
    async ({ ownerFilter, ids }) => {
      const inbox = new SessionInboxStore(env.DB);
      const options = {
        readScope: viewer,
        mode: "on" as const,
        viewerUserId: VIEWER_ID,
        limit: 1,
        ownerFilter,
      };
      const snapshot = await inbox.snapshot(options);
      expect(snapshot.finished.items.map(({ rootSession }) => rootSession.id)).toEqual(
        ids.slice(0, 1)
      );
      expect(snapshot.in_progress.items.map(({ rootSession }) => rootSession.id)).toEqual(
        ownerFilter === "anyone" ? ["unrelated"] : []
      );
      const allIds: string[] = [];
      let cursor = null;
      do {
        const page = await inbox.list({ ...options, category: "finished", cursor });
        allIds.push(...page.items.map(({ rootSession }) => rootSession.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(allIds).toEqual(ids);
    }
  );

  it.each([
    { visibility: "team" as const, scope: undefined, ids: ["team-root", "owned-child"] },
    { visibility: "workspace" as const, scope: undefined, ids: ["workspace-root", "read-only"] },
    { visibility: "private" as const, scope: undefined, ids: ["collaborating", "owned-private"] },
    {
      visibility: undefined,
      scope: "workspace" as const,
      ids: ["workspace-root", "collaborating", "read-only", "owned-private"],
    },
    { visibility: "team" as const, scope: "workspace" as const, ids: [] },
  ])(
    "composes $visibility visibility and $scope scope before grouping",
    async ({ visibility, scope, ids }) => {
      const inbox = new SessionInboxStore(env.DB);
      const options = {
        readScope: viewer,
        mode: "on" as const,
        viewerUserId: VIEWER_ID,
        limit: 20,
        visibility,
        scope,
      };
      const snapshot = await inbox.snapshot(options);
      const page = await inbox.list({ ...options, category: "finished", cursor: null });
      expect(page.items.map(({ rootSession }) => rootSession.id)).toEqual(ids);
      expect(snapshot.finished).toEqual(page);
      expect(page.items.every(({ descendantSessions }) => descendantSessions.length === 0)).toBe(
        true
      );
    }
  );

  it.each(["off", "shadow", "on"] as const)(
    "does not enumerate break-glass private rows in all scope in %s",
    async (mode) => {
      const inbox = new SessionInboxStore(env.DB);
      const options = {
        readScope: { ...viewer, roleKey: "owner" } as SessionViewer,
        mode,
        viewerUserId: VIEWER_ID,
        limit: 20,
        scope: "all" as const,
      };
      expect(
        (await inbox.snapshot(options)).in_progress.items.map(({ rootSession }) => rootSession.id)
      ).toEqual(["unrelated"]);
      expect(
        (await inbox.list({ ...options, category: "in_progress", cursor: null })).items.map(
          ({ rootSession }) => rootSession.id
        )
      ).toEqual(["unrelated"]);
    }
  );

  it("keeps Mine creator-only and excludes only directly automated rows with participation filters", async () => {
    await serviceFetch("https://example.com/me/authorization");
    const store = new SessionIndexStore(env.DB);
    await store.create(session("automated", { spawnSource: "automation", updatedAt: 10000 }));
    await store.create(session("bot", { spawnSource: "github-bot", updatedAt: 9000 }));
    await store.create(
      session("automation-child", {
        parentSessionId: "automated",
        spawnSource: "agent",
        spawnDepth: 1,
        automationId: "automation-1",
        updatedAt: 8000,
      })
    );
    const response = await serviceFetch(
      "https://example.com/sessions/inbox?mine=true&ownerFilter=participating"
    );
    const body = (await response.json()) as {
      categories: { finished: { items: Array<{ rootSession: { id: string } }> } };
    };
    expect(body.categories.finished.items.map(({ rootSession }) => rootSession.id)).toEqual([
      "automation-child",
      "team-root",
      "owned-child",
      "owned-private",
    ]);
  });

  it("returns persisted ownership and effective capabilities on snapshot and paged wire rows", async () => {
    const snapshot = (await (await serviceFetch("https://example.com/sessions/inbox")).json()) as {
      categories: { finished: unknown };
    };
    const page = await (
      await serviceFetch("https://example.com/sessions/inbox?category=finished")
    ).json();
    expect(page).toEqual(snapshot.categories.finished);
    expect(page).toMatchObject({
      items: expect.arrayContaining([
        {
          rootSession: expect.objectContaining({
            id: "workspace-root",
            ownerTeamId: null,
            visibility: "workspace",
            capabilities: expect.objectContaining({ canRead: true, canMove: false }),
          }),
          descendantSessions: [
            expect.objectContaining({
              id: "owned-child",
              ownerTeamId: "team-a",
              visibility: "team",
              capabilities: expect.objectContaining({
                canRead: true,
                canMove: true,
                canManageCollaborators: true,
              }),
            }),
          ],
        },
        {
          rootSession: expect.objectContaining({
            id: "collaborating",
            visibility: "private",
            capabilities: expect.objectContaining({
              canRead: true,
              canCollaborate: true,
              canSandbox: true,
              canManageCollaborators: false,
            }),
          }),
          descendantSessions: [],
        },
      ]),
    });
    expect(JSON.stringify(page)).not.toContain("userId");
  });
});
