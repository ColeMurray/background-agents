/** Unit tests for client subscription and command access, capabilities, and auditing. */

import { describe, it, expect, vi } from "vitest";
import { permissionsForBuiltInRole, type PermissionId } from "@open-inspect/shared/rbac";
import type { SessionAccessRow, SessionViewer } from "@open-inspect/shared";
import { createCloudflareBackgroundTasks } from "../cloudflare/background-tasks";
import type { Logger } from "../logger";
import {
  SessionConnectionAuthenticator,
  type SessionConnectionAuthenticatorDeps,
} from "./connection-authenticator";

function createLogger(): Logger {
  const log: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => log),
  };
  return log;
}

describe("client session access", () => {
  type UserViewer = Extract<SessionViewer, { kind: "user" }>;
  const teamRow: SessionAccessRow = {
    id: "session",
    ownerUserId: "owner-user",
    ownerTeamId: "team-b",
    visibility: "team",
    collaboratorIds: [],
  };
  const member: UserViewer = {
    kind: "user",
    userId: "member-user",
    roleKey: "member",
    suspended: false,
    permissions: permissionsForBuiltInRole("member"),
    memberships: new Map([["team-a", "member"]]),
  };
  const owner: UserViewer = {
    ...member,
    userId: "workspace-owner",
    roleKey: "owner",
    permissions: permissionsForBuiltInRole("owner"),
  };

  function accessHarness(mode: "off" | "shadow" | "on", viewer: UserViewer, row: SessionAccessRow) {
    const authorization = {
      userId: viewer.userId,
      role: { key: viewer.roleKey },
      permissions: viewer.permissions,
      suspendedAt: null,
    };
    const resolution = { kind: "valid" as const, mode, authorization, viewer, row };
    const close = vi.fn();
    const removeClient = vi.fn();
    const auditPrivateBreakGlass = vi.fn(async () => undefined);
    const auditShadowDenied = vi.fn<SessionConnectionAuthenticatorDeps["auditShadowDenied"]>(
      async () => undefined
    );
    const log = createLogger();
    const pendingBackgroundWork: Promise<unknown>[] = [];
    const backgroundTasks = createCloudflareBackgroundTasks(
      {
        waitUntil: vi.fn((task: Promise<unknown>) => {
          pendingBackgroundWork.push(task);
        }),
      },
      log
    );
    vi.spyOn(backgroundTasks, "submit");
    const connectionIds = new WeakMap<WebSocket, string>();
    let nextConnectionId = 0;
    const send = vi.fn((_ws: WebSocket, _message: { type: string; session?: unknown }) => true);
    const snapshot = {
      session: {
        codeServerUrl: "https://code.example.test",
        sandboxDashboardUrl: "https://dashboard.example.test",
        ttydUrl: "https://terminal.example.test",
        vncUrl: "https://vnc.example.test",
        tunnelUrls: { app: "https://app.example.test" },
      },
      artifacts: [],
      timeline: { events: [], hasMore: false, cursor: null },
      promptQueue: [],
    };
    const deps = {
      resolveSessionViewer: vi.fn(async () => resolution),
      wsManager: {
        close,
        removeClient,
        send,
        classify: vi.fn((ws: WebSocket) => {
          let wsId = connectionIds.get(ws);
          if (!wsId) {
            wsId = `ws-${++nextConnectionId}`;
            connectionIds.set(ws, wsId);
          }
          return { kind: "client", wsId };
        }),
        isClientAuthenticated: vi.fn(() => false),
        isClientSynchronizing: vi.fn(() => false),
        setClientSynchronizing: vi.fn(),
        activateClient: vi.fn(async (_ws: WebSocket, _info: unknown, synchronize: () => boolean) =>
          synchronize()
        ),
      },
      participantService: {
        getByWsTokenHash: vi.fn(() => ({
          id: "participant-1",
          user_id: "member-user",
          canonical_user_id: authorization.userId,
          ws_token_created_at: Date.now(),
          scm_login: null,
        })),
      },
      snapshotReader: {
        resolveSessionSnapshotEnrichment: vi.fn(async () => ({})),
        readSessionSnapshot: vi.fn(() => snapshot),
      },
      scmProviderName: "github",
      presenceService: { sendPresence: vi.fn(), broadcastPresence: vi.fn() },
      schedulePullRequestRefresh: vi.fn(),
      backgroundTasks,
      auditPrivateBreakGlass,
      auditShadowDenied,
      log,
    } as unknown as SessionConnectionAuthenticatorDeps;
    return {
      authenticator: new SessionConnectionAuthenticator(deps),
      close,
      removeClient,
      send,
      auditPrivateBreakGlass,
      auditShadowDenied,
      backgroundTasks,
      pendingBackgroundWork,
      log,
      resolveSessionViewer: deps.resolveSessionViewer,
      snapshotReader: deps.snapshotReader,
      activateClient: deps.wsManager.activateClient,
      setClientSynchronizing: deps.wsManager.setClientSynchronizing,
      presenceService: deps.presenceService,
      schedulePullRequestRefresh: deps.schedulePullRequestRefresh,
    };
  }

  it.each(["off", "shadow", "on"] as const)(
    "uses the %s mode for the team rule at subscribe and on commands",
    async (mode) => {
      const { authenticator, close, resolveSessionViewer, auditShadowDenied } = accessHarness(
        mode,
        member,
        teamRow
      );
      const socket = {} as WebSocket;
      await authenticator.handleSubscribe(socket, { token: "token", clientId: "client" });
      expect(close).toHaveBeenCalledTimes(mode === "on" ? 1 : 0);
      if (mode === "on") expect(close).toHaveBeenCalledWith({}, 4010, expect.any(String));
      expect(
        await authenticator.authorizeClientCommand(socket, member.userId, "collaborate")
      ).toEqual(mode === "on" ? { kind: "revoked" } : { kind: "denied", reason: "not_member" });
      expect(resolveSessionViewer).toHaveBeenNthCalledWith(1, member.userId, {
        includeMemberships: true,
      });
      expect(resolveSessionViewer).toHaveBeenNthCalledWith(2, member.userId);
      expect(auditShadowDenied).toHaveBeenCalledTimes(mode === "shadow" ? 1 : 0);
      if (mode === "shadow") {
        expect(auditShadowDenied).toHaveBeenCalledWith(
          member.userId,
          teamRow,
          "not_member",
          "ws-1"
        );
      }
    }
  );

  it("deduplicates subscribe and repeated read/collaboration checks using the canonical actor", async () => {
    const viewer = { ...member, userId: "canonical-user" };
    const { authenticator, auditShadowDenied, close, send } = accessHarness(
      "shadow",
      viewer,
      teamRow
    );
    const socket = {} as WebSocket;

    await authenticator.handleSubscribe(socket, { token: "token", clientId: "client" });
    expect(send).toHaveBeenCalledWith(socket, expect.objectContaining({ type: "subscribed" }));
    for (let i = 0; i < 3; i++) {
      expect(await authenticator.authorizeClientCommand(socket, viewer.userId, "read")).toEqual({
        kind: "allowed",
      });
      expect(
        await authenticator.authorizeClientCommand(socket, viewer.userId, "collaborate")
      ).toEqual({
        kind: "denied",
        reason: "not_member",
      });
    }
    expect(auditShadowDenied).toHaveBeenCalledExactlyOnceWith(
      viewer.userId,
      teamRow,
      "not_member",
      "ws-1"
    );
    expect(close).not.toHaveBeenCalled();
  });

  it.each(["enrichment", "missing_snapshot", "snapshot_error", "send", "activation"] as const)(
    "does not observe a shadow read when subscription fails at %s",
    async (failure) => {
      const {
        authenticator,
        auditShadowDenied,
        backgroundTasks,
        snapshotReader,
        activateClient,
        send,
        close,
      } = accessHarness("shadow", member, teamRow);
      const error = new Error("Subscription failed");
      if (failure === "enrichment") {
        vi.mocked(snapshotReader.resolveSessionSnapshotEnrichment).mockRejectedValue(error);
      } else if (failure === "missing_snapshot") {
        vi.mocked(snapshotReader.readSessionSnapshot).mockReturnValue(null);
      } else if (failure === "snapshot_error") {
        vi.mocked(snapshotReader.readSessionSnapshot).mockImplementation(() => {
          throw error;
        });
      } else if (failure === "send") {
        send.mockReturnValue(false);
      } else {
        vi.mocked(activateClient).mockRejectedValue(error);
      }

      const socket = {} as WebSocket;
      const subscription = authenticator.handleSubscribe(socket, {
        token: "token",
        clientId: "client",
      });
      if (failure === "enrichment") {
        await expect(subscription).rejects.toThrow(error);
      } else {
        await subscription;
        expect(close).toHaveBeenCalledWith(
          socket,
          failure === "send" || failure === "missing_snapshot" ? 4009 : 1011,
          expect.any(String)
        );
      }
      expect(auditShadowDenied).not.toHaveBeenCalled();
      expect(backgroundTasks.submit).not.toHaveBeenCalled();
    }
  );

  it.each(["membership", "scope"])(
    "observes a fresh %s change midlease only once",
    async (change) => {
      const memberships = new Map([["team-b", "member"]] as const);
      const viewer = { ...member, memberships };
      const row = { ...teamRow };
      const { authenticator, auditShadowDenied, close } = accessHarness("shadow", viewer, row);
      const socket = {} as WebSocket;

      await authenticator.handleSubscribe(socket, { token: "token", clientId: "client" });
      expect(auditShadowDenied).not.toHaveBeenCalled();
      if (change === "membership") memberships.delete("team-b");
      else row.ownerTeamId = "other-team";
      for (let i = 0; i < 3; i++) {
        expect(await authenticator.authorizeClientCommand(socket, viewer.userId, "read")).toEqual({
          kind: "allowed",
        });
      }
      expect(auditShadowDenied).toHaveBeenCalledExactlyOnceWith(
        viewer.userId,
        row,
        "not_member",
        "ws-1"
      );
      expect(close).not.toHaveBeenCalled();
    }
  );

  it("does not observe an actual denied read or a collaboration-only denial", async () => {
    for (const row of [
      { ...teamRow, visibility: "private" as const },
      { ...teamRow, visibility: "workspace" as const },
    ]) {
      const { authenticator, auditShadowDenied } = accessHarness("shadow", member, row);
      const socket = {} as WebSocket;
      await authenticator.handleSubscribe(socket, { token: "token", clientId: "client" });
      await authenticator.authorizeClientCommand(socket, member.userId, "collaborate");
      expect(auditShadowDenied).not.toHaveBeenCalled();
    }
  });

  it.each(["reject", "throw"])(
    "preserves subscribe and command decisions when the audit writer %s fails",
    async (failure) => {
      const {
        authenticator,
        auditShadowDenied,
        backgroundTasks,
        pendingBackgroundWork,
        log,
        close,
        send,
      } = accessHarness("shadow", member, teamRow);
      const error = new Error("D1 unavailable");
      if (failure === "reject") auditShadowDenied.mockRejectedValue(error);
      else
        auditShadowDenied.mockImplementation(() => {
          throw error;
        });
      const socket = {} as WebSocket;

      await authenticator.handleSubscribe(socket, { token: "token", clientId: "client" });
      expect(send).toHaveBeenCalledWith(socket, expect.objectContaining({ type: "subscribed" }));
      expect(await authenticator.authorizeClientCommand(socket, member.userId, "read")).toEqual({
        kind: "allowed",
      });
      expect(
        await authenticator.authorizeClientCommand(socket, member.userId, "collaborate")
      ).toEqual({
        kind: "denied",
        reason: "not_member",
      });
      expect(auditShadowDenied).toHaveBeenCalledOnce();
      expect(backgroundTasks.submit).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
      await Promise.all(pendingBackgroundWork);
      expect(log.error).toHaveBeenCalledExactlyOnceWith("background_task.failed", {
        task_name: "session.shadow_denied",
        user_id: member.userId,
        session_id: teamRow.id,
        error,
      });
    }
  );

  it("completes subscription and success side effects while the shadow audit is pending", async () => {
    const h = accessHarness("shadow", member, teamRow);
    let finishAudit!: () => void;
    let auditSettled = false;
    h.auditShadowDenied.mockReturnValue(
      new Promise<void>((resolve) => {
        finishAudit = resolve;
      }).then(() => {
        auditSettled = true;
      })
    );
    const socket = {} as WebSocket;

    try {
      await expect(
        h.authenticator.handleSubscribe(socket, { token: "token", clientId: "client" })
      ).resolves.toBeUndefined();

      expect(auditSettled).toBe(false);
      expect(h.auditShadowDenied).toHaveBeenCalledExactlyOnceWith(
        member.userId,
        teamRow,
        "not_member",
        "ws-1"
      );
      expect(h.backgroundTasks.submit).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
        name: "session.shadow_denied",
        context: { user_id: member.userId, session_id: teamRow.id },
      });
      expect(h.activateClient).toHaveBeenCalledOnce();
      expect(h.send).toHaveBeenCalledWith(socket, expect.objectContaining({ type: "subscribed" }));
      expect(h.log.info).toHaveBeenCalledWith(
        "ws.connect",
        expect.objectContaining({ ws_type: "client", outcome: "success", client_id: "client" })
      );
      expect(h.presenceService.sendPresence).toHaveBeenCalledExactlyOnceWith(socket);
      expect(h.presenceService.broadcastPresence).toHaveBeenCalledOnce();
      expect(h.schedulePullRequestRefresh).toHaveBeenCalledExactlyOnceWith("open");
      expect(vi.mocked(h.setClientSynchronizing).mock.calls).toEqual([
        [socket, true],
        [socket, false],
      ]);
      expect(h.close).not.toHaveBeenCalled();
      expect(h.removeClient).not.toHaveBeenCalled();
    } finally {
      finishAudit();
      await Promise.all(h.pendingBackgroundWork);
    }
  });

  it.each(["read", "collaborate"] as const)(
    "completes the first %s command and deduplicates commands while the shadow audit is pending",
    async (action) => {
      const h = accessHarness("shadow", member, teamRow);
      let finishAudit!: () => void;
      let auditSettled = false;
      h.auditShadowDenied.mockReturnValue(
        new Promise<void>((resolve) => {
          finishAudit = resolve;
        }).then(() => {
          auditSettled = true;
        })
      );
      const socket = {} as WebSocket;
      const allowed = { kind: "allowed" };
      const denied = { kind: "denied", reason: "not_member" };
      const firstDecision = action === "read" ? allowed : denied;
      const commands = Promise.all([
        h.authenticator.authorizeClientCommand(socket, member.userId, action),
        h.authenticator.authorizeClientCommand(socket, member.userId, "read"),
        h.authenticator.authorizeClientCommand(socket, member.userId, "collaborate"),
        h.authenticator.authorizeClientCommand(socket, member.userId, action),
      ]);

      try {
        await expect(commands).resolves.toEqual([firstDecision, allowed, denied, firstDecision]);
        expect(auditSettled).toBe(false);
        expect(h.auditShadowDenied).toHaveBeenCalledExactlyOnceWith(
          member.userId,
          teamRow,
          "not_member",
          "ws-1"
        );
        expect(h.backgroundTasks.submit).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
          name: "session.shadow_denied",
          context: { user_id: member.userId, session_id: teamRow.id },
        });
        expect(h.close).not.toHaveBeenCalled();
        expect(h.removeClient).not.toHaveBeenCalled();
      } finally {
        finishAudit();
        await commands;
        await Promise.all(h.pendingBackgroundWork);
      }
    }
  );

  it("keeps denial observations distinct per connection and session", async () => {
    const row = { ...teamRow };
    const { authenticator, auditShadowDenied } = accessHarness("shadow", member, row);
    const first = {} as WebSocket;
    const second = {} as WebSocket;
    await authenticator.handleSubscribe(first, { token: "token", clientId: "reused-client-id" });
    await authenticator.handleSubscribe(second, { token: "token", clientId: "reused-client-id" });
    expect(auditShadowDenied).toHaveBeenCalledTimes(2);
    expect(auditShadowDenied.mock.calls.map((args) => args[3])).toEqual(["ws-1", "ws-2"]);

    row.id = "other-session";
    await authenticator.authorizeClientCommand(first, member.userId, "read");
    expect(auditShadowDenied).toHaveBeenCalledTimes(3);
  });

  it("retains a read-only socket when only collaboration is denied", async () => {
    const viewer: UserViewer = {
      ...member,
      memberships: new Map([["team-b", "member"]]),
      permissions: ["sessions.read"],
    };
    const { authenticator, close, removeClient } = accessHarness("on", viewer, teamRow);
    const socket = {} as WebSocket;
    await authenticator.handleSubscribe(socket, { token: "token", clientId: "read-only" });

    expect(
      await authenticator.authorizeClientCommand(socket, viewer.userId, "collaborate")
    ).toEqual({
      kind: "denied",
      reason: "missing_permission",
    });
    expect(close).not.toHaveBeenCalled();
    expect(removeClient).not.toHaveBeenCalled();
  });

  it.each(
    (["off", "shadow", "on"] as const).flatMap((mode) =>
      (["workspace", "team", "private"] as const).map((visibility) => ({ mode, visibility }))
    )
  )(
    "sends fresh team-member capabilities for $visibility subscriptions in $mode mode",
    async ({ mode, visibility }) => {
      const permissions: PermissionId[] = [
        "sessions.read",
        "sessions.collaborate",
        "sessions.lifecycle",
        "sessions.delete",
        "sessions.sandbox_access",
      ];
      const viewer: UserViewer = {
        ...member,
        memberships: new Map([["team-b", "member"]]),
        permissions,
      };
      const { authenticator, send, close } = accessHarness(mode, viewer, {
        ...teamRow,
        visibility,
        collaboratorIds: visibility === "private" ? [viewer.userId] : [],
      });
      const subscribe = () =>
        authenticator.handleSubscribe({} as WebSocket, { token: "token", clientId: "client" });
      const expectedCapabilities = {
        canRead: true,
        canCollaborate: true,
        canManageLifecycle: true,
        canDelete: false,
        canSandbox: true,
        canManageCollaborators: false,
        canChangeVisibility: false,
      };

      await subscribe();
      expect(send).toHaveBeenLastCalledWith(
        {},
        expect.objectContaining({
          type: "subscribed",
          session: expect.objectContaining({ capabilities: expectedCapabilities }),
        })
      );
      expect(send.mock.calls.at(-1)?.[1]).toHaveProperty(
        "session.codeServerUrl",
        "https://code.example.test"
      );
      for (const action of ["collaborate", "lifecycle", "sandbox"] as const) {
        expect(
          await authenticator.authorizeClientCommand({} as WebSocket, viewer.userId, action)
        ).toEqual({ kind: "allowed" });
      }
      expect(
        await authenticator.authorizeClientCommand({} as WebSocket, viewer.userId, "delete")
      ).toEqual({ kind: "denied", reason: "not_owner_or_lead" });

      const originalPermissions = [...permissions];
      permissions.splice(0, permissions.length, "sessions.read");
      await subscribe();
      expect(send).toHaveBeenLastCalledWith(
        {},
        expect.objectContaining({
          type: "subscribed",
          session: expect.objectContaining({
            capabilities: {
              ...expectedCapabilities,
              canCollaborate: false,
              canManageLifecycle: false,
              canSandbox: false,
            },
          }),
        })
      );

      permissions.push(...originalPermissions.slice(1));
      await subscribe();
      expect(send).toHaveBeenLastCalledWith(
        {},
        expect.objectContaining({
          type: "subscribed",
          session: expect.objectContaining({ capabilities: expectedCapabilities }),
        })
      );
      expect(close).not.toHaveBeenCalled();
    }
  );

  describe.each(["off", "shadow", "on"] as const)(
    "team-owned subscriptions and commands in %s mode",
    (mode) => {
      it.each([
        {
          label: "workspace Member",
          viewer: member,
          row: { ...teamRow, visibility: "workspace" as const },
        },
        {
          label: "workspace Admin",
          viewer: {
            ...member,
            userId: "workspace-admin",
            roleKey: "administrator" as const,
            permissions: permissionsForBuiltInRole("administrator"),
          },
          row: { ...teamRow, visibility: "workspace" as const },
        },
        {
          label: "workspace Owner",
          viewer: owner,
          row: { ...teamRow, visibility: "workspace" as const },
        },
        {
          label: "removed private session owner",
          viewer: { ...member, userId: "owner-user" },
          row: { ...teamRow, visibility: "private" as const },
        },
        {
          label: "private Owner break-glass reader",
          viewer: owner,
          row: { ...teamRow, visibility: "private" as const },
        },
      ])("keeps a $label read-only without team membership", async ({ viewer, row }) => {
        const { authenticator, send, close, removeClient } = accessHarness(mode, viewer, row);
        const socket = {} as WebSocket;

        await authenticator.handleSubscribe(socket, { token: "token", clientId: "nonmember" });

        const subscribed = send.mock.calls.find(
          ([, message]) => message.type === "subscribed"
        )?.[1];
        expect(subscribed).toHaveProperty("session.capabilities", {
          canRead: true,
          canCollaborate: false,
          canManageLifecycle: false,
          canDelete: false,
          canSandbox: false,
          canManageCollaborators: false,
          canChangeVisibility: false,
        });
        for (const field of [
          "codeServerUrl",
          "sandboxDashboardUrl",
          "ttydUrl",
          "vncUrl",
          "tunnelUrls",
        ]) {
          expect(subscribed).not.toHaveProperty(`session.${field}`);
        }
        expect(await authenticator.authorizeClientCommand(socket, viewer.userId, "read")).toEqual({
          kind: "allowed",
        });
        for (const action of [
          "collaborate",
          "lifecycle",
          "delete",
          "sandbox",
          "manageCollaborators",
          "changeVisibility",
        ] as const) {
          expect(await authenticator.authorizeClientCommand(socket, viewer.userId, action)).toEqual(
            {
              kind: "denied",
              reason: "not_member",
            }
          );
        }
        expect(close).not.toHaveBeenCalled();
        expect(removeClient).not.toHaveBeenCalled();
      });
    }
  );

  it("closes on lost read access but not on a collaboration-only denial", async () => {
    const memberships = new Map([["team-b", "member"]] as const);
    const row = { ...teamRow };
    const viewer: UserViewer = { ...member, memberships };
    const { authenticator, close, removeClient, resolveSessionViewer } = accessHarness(
      "on",
      viewer,
      row
    );
    const socket = {} as WebSocket;

    await authenticator.handleSubscribe(socket, { token: "token", clientId: "member" });
    expect(close).not.toHaveBeenCalled();
    expect(
      await authenticator.authorizeClientCommand(socket, viewer.userId, "collaborate")
    ).toEqual({
      kind: "allowed",
    });

    memberships.delete("team-b");
    expect(
      await authenticator.authorizeClientCommand(socket, viewer.userId, "collaborate")
    ).toEqual({
      kind: "revoked",
    });
    expect(removeClient).toHaveBeenCalledWith(socket);
    expect(close).toHaveBeenCalledWith(socket, 4010, expect.any(String));

    memberships.set("team-b", "member");
    row.ownerTeamId = "team-a";
    expect(await authenticator.authorizeClientCommand(socket, viewer.userId, "read")).toEqual({
      kind: "revoked",
    });
    expect(resolveSessionViewer).toHaveBeenCalledTimes(4);
  });

  it.each(
    (["off", "shadow", "on"] as const).flatMap((mode) => [
      { mode, label: "non-collaborators", collaboratorIds: [] },
      { mode, label: "nonmember collaborators", collaboratorIds: [member.userId] },
    ])
  )("refuses private $label in $mode mode", async ({ mode, collaboratorIds }) => {
    const { authenticator, close } = accessHarness(mode, member, {
      ...teamRow,
      visibility: "private",
      collaboratorIds,
    });
    await authenticator.handleSubscribe({} as WebSocket, { token: "token", clientId: "client" });
    expect(close).toHaveBeenCalledWith({}, 4010, expect.any(String));
    expect(
      await authenticator.authorizeClientCommand({} as WebSocket, member.userId, "read")
    ).toEqual({
      kind: "revoked",
    });
  });

  it.each(["off", "shadow", "on"] as const)(
    "redacts workspace-owned Owner break-glass URLs in %s, permits lifecycle but not collaboration",
    async (mode) => {
      const { authenticator, send, close, auditPrivateBreakGlass } = accessHarness(mode, owner, {
        ...teamRow,
        ownerTeamId: null,
        visibility: "private",
      });
      await authenticator.handleSubscribe({} as WebSocket, { token: "token", clientId: "client" });

      expect(close).not.toHaveBeenCalled();
      const subscribed = send.mock.calls.find(([, message]) => message.type === "subscribed")?.[1];
      expect(subscribed).toBeDefined();
      expect(subscribed).not.toHaveProperty("session.codeServerUrl");
      expect(subscribed).not.toHaveProperty("session.sandboxDashboardUrl");
      expect(subscribed).not.toHaveProperty("session.ttydUrl");
      expect(subscribed).not.toHaveProperty("session.vncUrl");
      expect(subscribed).not.toHaveProperty("session.tunnelUrls");
      expect(subscribed).toHaveProperty("session.capabilities", {
        canRead: true,
        canCollaborate: false,
        canManageLifecycle: true,
        canDelete: true,
        canSandbox: false,
        canManageCollaborators: true,
        canChangeVisibility: true,
      });
      expect(auditPrivateBreakGlass).toHaveBeenCalledExactlyOnceWith(
        owner.userId,
        expect.objectContaining({ id: "session", visibility: "private" })
      );
      expect(
        await authenticator.authorizeClientCommand({} as WebSocket, owner.userId, "collaborate")
      ).toEqual({ kind: "denied", reason: "not_collaborator" });
      expect(
        await authenticator.authorizeClientCommand({} as WebSocket, owner.userId, "lifecycle")
      ).toEqual({ kind: "allowed" });
      expect(auditPrivateBreakGlass).toHaveBeenCalledOnce();
    }
  );

  it("refuses a break-glass subscription if its audit write fails", async () => {
    const { authenticator, auditPrivateBreakGlass, close, send } = accessHarness("on", owner, {
      ...teamRow,
      visibility: "private",
    });
    auditPrivateBreakGlass.mockRejectedValue(new Error("D1 unavailable"));
    const socket = {} as WebSocket;

    await authenticator.handleSubscribe(socket, { token: "token", clientId: "owner" });

    expect(close).toHaveBeenCalledWith(socket, 1011, "Authorization temporarily unavailable");
    expect(send).not.toHaveBeenCalled();
  });
});
