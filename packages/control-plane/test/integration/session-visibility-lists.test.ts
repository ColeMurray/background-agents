import { checkSessionAccess, type SessionViewer } from "@open-inspect/shared";
import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AnalyticsStore } from "../../src/db/analytics-store";
import { PrAutofixFeedbackStore } from "../../src/db/pr-autofix-feedback-store";
import { SessionExportStore } from "../../src/db/session-export-store";
import { SessionIndexStore, type SessionEntry } from "../../src/db/session-index";
import { SessionRunStore } from "../../src/db/session-run-store";
import { cleanD1Tables } from "./cleanup";

const USERS = ["owner", "admin", "viewer", "collaborator", "outsider"] as const;
const PUBLIC_IDS = ["workspace-root", "alpha-root", "beta-root", "beta-child"];
const FILTERS = { startAt: 1000, endAt: 2000, scope: "all" as const };

function userViewer(
  userId: (typeof USERS)[number],
  roleKey: "owner" | "administrator" | "member"
): Extract<SessionViewer, { kind: "user" }> {
  return {
    kind: "user",
    userId,
    roleKey,
    permissions: ["sessions.read"],
    suspended: false,
    memberships: new Map(
      userId === "viewer"
        ? [["team_alpha", "member"] as const]
        : userId === "collaborator"
          ? [["team_beta", "member"] as const]
          : []
    ),
  };
}

async function seedFixture(): Promise<void> {
  await env.DB.batch(
    USERS.map((id) =>
      env.DB.prepare(
        "INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, 1, 1)"
      ).bind(id, id)
    )
  );
  await env.DB.prepare(
    "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team_alpha', 'alpha', 'Alpha', 1, 1), ('team_beta', 'beta', 'Beta', 1, 1)"
  ).run();
  await env.DB.prepare(
    "INSERT INTO team_memberships (team_id, user_id, created_at) VALUES ('team_alpha', 'viewer', 1), ('team_beta', 'collaborator', 1)"
  ).run();

  const index = new SessionIndexStore(env.DB);
  const rows: Array<{
    id: string;
    visibility: SessionEntry["visibility"];
    ownerTeamId: string | null;
    userId: string;
    cost: number;
    parentSessionId?: string;
    status?: SessionEntry["status"];
  }> = [
    {
      id: "workspace-root",
      visibility: "workspace",
      ownerTeamId: null,
      userId: "outsider",
      cost: 1,
    },
    { id: "alpha-root", visibility: "team", ownerTeamId: "team_alpha", userId: "viewer", cost: 2 },
    {
      id: "beta-root",
      visibility: "team",
      ownerTeamId: "team_beta",
      userId: "collaborator",
      cost: 4,
    },
    {
      id: "beta-child",
      visibility: "team",
      ownerTeamId: "team_beta",
      userId: "collaborator",
      cost: 8,
      parentSessionId: "workspace-root",
      status: "active",
    },
    { id: "own-private", visibility: "private", ownerTeamId: null, userId: "viewer", cost: 16 },
    {
      id: "shared-private",
      visibility: "private",
      // Team-owned collaborator grants require membership, so share within the collaborator's team.
      ownerTeamId: "team_beta",
      userId: "outsider",
      cost: 32,
    },
    {
      id: "private-child",
      visibility: "private",
      ownerTeamId: null,
      userId: "outsider",
      cost: 64,
      parentSessionId: "workspace-root",
      status: "active",
    },
  ];
  for (const [position, row] of rows.entries()) {
    await index.create({
      id: row.id,
      title: row.id,
      ownerTeamId: row.ownerTeamId,
      visibility: row.visibility,
      userId: row.userId,
      repoOwner: "acme",
      repoName: "widgets",
      baseBranch: "main",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      status: row.status ?? "completed",
      parentSessionId: row.parentSessionId,
      spawnSource: row.parentSessionId ? "agent" : "user",
      spawnDepth: row.parentSessionId ? 1 : 0,
      createdAt: 1000 + position,
      updatedAt: 1000 + position,
    });
    await index.updateMetrics(row.id, {
      totalCost: row.cost,
      activeDurationMs: 0,
      messageCount: 0,
      prCount: 0,
      inputTokens: row.cost,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  }
  await env.DB.prepare(
    "INSERT INTO session_collaborators (session_id, user_id, added_by, created_at) VALUES ('shared-private', 'collaborator', 'outsider', 1)"
  ).run();
  for (const id of ["beta-child", "private-child"]) {
    await index.recordLatestTerminalMessage({
      sessionId: id,
      messageId: `message-${id}`,
      messageCreatedAt: 1100,
      terminalMessageCompletedAt: 1100,
    });
  }
  await env.DB.batch(
    [...rows.map(({ id }) => id), "unattached"].map((id, position) =>
      env.DB.prepare(
        `INSERT INTO pr_autofix_feedback
         (feedback_key, provider_object_kind, provider_object_id, delivery_id,
          repository_external_id, repo_owner, repo_name, pr_number, session_id,
          decision, first_received_at, last_received_at)
         VALUES (?, 'pr_comment', ?, ?, '1', 'acme', 'widgets', 1, ?, 'received', ?, ?)`
      ).bind(
        `feedback-${id}`,
        id,
        `delivery-${id}`,
        id === "unattached" ? null : id,
        1200 + position,
        1200 + position
      )
    )
  );
}

describe("cross-reader D1 session visibility", () => {
  beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
  beforeEach(async () => {
    await cleanD1Tables();
    await seedFixture();
  });
  afterEach(cleanD1Tables);

  it("agrees across lists, inbox, both exports, and analytics for each viewer and mode", async () => {
    const index = new SessionIndexStore(env.DB);
    const exports = new SessionExportStore(env.DB);
    expect(
      checkSessionAccess(
        userViewer("owner", "owner"),
        {
          id: "private-child",
          ownerUserId: "outsider",
          ownerTeamId: null,
          visibility: "private",
          collaboratorIds: [],
        },
        "read"
      )
    ).toEqual({ allowed: true, audit: "session.private_break_glass" });
    const cases = [
      {
        viewer: userViewer("viewer", "member"),
        mode: "on" as const,
        ids: ["workspace-root", "alpha-root", "own-private"],
        publicIds: ["workspace-root", "alpha-root"],
        cost: 3,
        attention: [],
      },
      {
        viewer: userViewer("viewer", "member"),
        mode: "shadow" as const,
        ids: [...PUBLIC_IDS, "own-private"],
        publicIds: PUBLIC_IDS,
        cost: 15,
        attention: ["workspace-root"],
      },
      {
        viewer: userViewer("viewer", "member"),
        mode: "off" as const,
        ids: [...PUBLIC_IDS, "own-private"],
        publicIds: PUBLIC_IDS,
        cost: 15,
        attention: ["workspace-root"],
      },
      {
        viewer: userViewer("collaborator", "member"),
        mode: "on" as const,
        ids: ["workspace-root", "beta-root", "beta-child", "shared-private"],
        publicIds: ["workspace-root", "beta-root", "beta-child"],
        cost: 13,
        attention: ["workspace-root"],
      },
      {
        viewer: userViewer("collaborator", "member"),
        mode: "shadow" as const,
        ids: [...PUBLIC_IDS, "shared-private"],
        publicIds: PUBLIC_IDS,
        cost: 15,
        attention: ["workspace-root"],
      },
      {
        viewer: userViewer("admin", "administrator"),
        mode: "on" as const,
        ids: PUBLIC_IDS,
        publicIds: PUBLIC_IDS,
        cost: 15,
        attention: ["workspace-root"],
      },
      {
        viewer: userViewer("owner", "owner"),
        mode: "on" as const,
        ids: PUBLIC_IDS,
        publicIds: PUBLIC_IDS,
        cost: 15,
        attention: ["workspace-root"],
      },
    ];

    for (const { viewer, mode, ids, publicIds, cost, attention } of cases) {
      const expected = [...ids].sort();
      const label = `${viewer.kind === "user" ? viewer.userId : "service"}/${mode}`;
      const listed = await index.list({ readScope: viewer, mode, limit: 20 });
      expect(listed.sessions.map(({ id }) => id).sort(), label).toEqual(expected);
      expect(listed.hasMore, label).toBe(false);

      const inbox = await index.listInboxSnapshot({
        readScope: viewer,
        mode,
        viewerUserId: viewer.userId,
        limit: 20,
      });
      const inboxIds = Object.values(inbox).flatMap(({ items }) =>
        items.flatMap(({ rootSession, descendantSessions }) => [
          rootSession.id,
          ...descendantSessions.map(({ id }) => id),
        ])
      );
      expect(inboxIds.sort(), label).toEqual(expected);
      expect(
        inbox.needs_attention.items.map(({ rootSession }) => rootSession.id),
        label
      ).toEqual(attention);
      expect(inbox.in_progress.items, label).toEqual([]);
      expect(
        inbox.finished.items
          .flatMap(({ rootSession, descendantSessions }) => [
            rootSession.id,
            ...descendantSessions.map(({ id }) => id),
          ])
          .sort(),
        label
      ).toEqual(expected.filter((id) => !attention.includes(id) && id !== "beta-child").sort());

      const sessionsPage = await exports.list({ readScope: viewer, mode, cursor: null, limit: 20 });
      const runsPage = await exports.list({
        readScope: viewer,
        mode,
        scope: "runs",
        cursor: null,
        limit: 20,
      });
      expect(sessionsPage.sessions.map(({ id }) => id).sort(), label).toEqual(expected);
      expect(runsPage.sessions.map(({ id }) => id).sort(), label).toEqual(expected);
      expect(sessionsPage.nextCursor, label).toBeNull();
      expect(runsPage.nextCursor, label).toBeNull();

      const analytics = new AnalyticsStore(env.DB, viewer, mode);
      const summary = await analytics.getSummary(FILTERS);
      const breakdown = await analytics.getBreakdown(FILTERS, "repo");
      const byUser = await analytics.getBreakdown(FILTERS, "user");
      expect(summary, label).toMatchObject({
        totalSessions: publicIds.length,
        totalCost: cost,
        inputTokens: cost,
        privateSessionsCostUsd:
          viewer.roleKey === "owner" || viewer.roleKey === "administrator" ? 112 : null,
      });
      expect(breakdown.entries, label).toMatchObject([
        { key: "acme/widgets", sessions: publicIds.length, cost, inputTokens: cost },
      ]);
      expect(
        byUser.entries.reduce((sum, entry) => sum + entry.sessions, 0),
        label
      ).toBe(publicIds.length);
      expect(
        byUser.entries.reduce((sum, entry) => sum + entry.cost, 0),
        label
      ).toBe(cost);

      const runs = await new SessionRunStore(env.DB, viewer, mode).list({
        ...FILTERS,
        orderBy: "cost",
        limit: 20,
      });
      expect(
        runs.reduce((sum, run) => sum + run.sessionCount, 0),
        label
      ).toBe(publicIds.length);
      expect(
        runs.reduce((sum, run) => sum + run.totalCost, 0),
        label
      ).toBe(cost);
    }

    expect(
      (
        await index.list({
          readScope: userViewer("viewer", "member"),
          mode: "on",
          search: "alpha",
          limit: 20,
        })
      ).sessions.map(({ id }) => id)
    ).toEqual(["alpha-root"]);
  });

  it("keeps private rows out of service lists and autofix activity, including before paging", async () => {
    const index = new SessionIndexStore(env.DB);
    const exports = new SessionExportStore(env.DB);
    for (const [viewer, expected] of [
      [{ kind: "service", teamId: null }, PUBLIC_IDS],
      [{ kind: "service", teamId: "team_alpha" }, ["workspace-root", "alpha-root"]],
    ] as const satisfies ReadonlyArray<readonly [SessionViewer, readonly string[]]>) {
      expect(
        (await index.list({ readScope: viewer, mode: "on", limit: 20 })).sessions
          .map(({ id }) => id)
          .sort()
      ).toEqual([...expected].sort());
      for (const mode of ["off", "shadow"] as const) {
        expect(
          (await exports.list({ readScope: viewer, mode, cursor: null, limit: 20 })).sessions
            .map(({ id }) => id)
            .sort()
        ).toEqual([...PUBLIC_IDS].sort());
      }
    }

    const activity = new PrAutofixFeedbackStore(env.DB);
    const sessionIds: Array<string | null> = [];
    let cursor: string | null = null;
    do {
      const page = await activity.listActivity({ limit: 2, cursor });
      sessionIds.push(...page.records.map(({ sessionId }) => sessionId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(sessionIds).toEqual([null, "beta-child", "beta-root", "alpha-root", "workspace-root"]);
  });
});
