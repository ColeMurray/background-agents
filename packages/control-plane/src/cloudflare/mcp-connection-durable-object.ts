import { DurableObject } from "cloudflare:workers";
import { MCPClientManager } from "agents/mcp/client";
import { Lifecycle } from "agents/lifecycle";
import { requireMcpOAuthEncryptionKey } from "../env-validation";
import type { McpBrokerCall, McpBrokerCallResult } from "../mcp/broker-contract";
import {
  D1McpOAuthStorage,
  EncryptedMcpOAuthClientProvider,
} from "../mcp/encrypted-oauth-provider";
import { resolveMcpOAuthKeyring } from "../mcp/oauth-keyring";
import { McpConnectionStore, type McpTransportStatus } from "../db/mcp-connections";
import type {
  McpConnectionAuthorization,
  McpConnectionTransportState,
} from "@open-inspect/shared/types/integrations";
import type { WorkerBindings } from "./platform";

type McpConnectionBindings = Pick<
  WorkerBindings,
  "DB" | "MCP_OAUTH_ENCRYPTION_KEY" | "WORKER_URL" | "WEB_APP_URL"
>;
const CONNECTION_ID_KEY = "open-inspect:mcp-connection-id";
/** The longest one reviewed tool call may take. */
const MCP_TOOL_TIMEOUT_MS = 30_000;
/** The longest one authorization attempt may take before the owner is told it did not complete. */
const MCP_AUTHORIZE_TIMEOUT_MS = 30_000;

/**
 * The public URL the server sends the owner back to after an OAuth approval.
 *
 * The broker owns the connection, so the callback goes to the broker's own
 * route and nowhere else.
 */
export function mcpCallbackUrl(env: { WORKER_URL?: string }, connectionId: string): string {
  const base = env.WORKER_URL?.trim();
  if (!base) throw new Error("The MCP connection callback URL is not configured");
  return `${base.replace(/\/+$/, "")}/mcp/oauth/callback/${encodeURIComponent(connectionId)}`;
}
const OWNER_USER_ID_KEY = "open-inspect:mcp-owner-user-id";
const DELETED_KEY = "open-inspect:mcp-deleted";
interface BrokerTombstone {
  connectionId: string;
  ownerUserId: string;
}

/**
 * The personal MCP broker.
 *
 * The manager is a Lifecycle capability, so it is installed on one: that is
 * what restores the persisted registration after a cold start, what serves the
 * server's OAuth callback, and what owns the credential. The credential lives
 * encrypted in D1 and never leaves the broker; the owner receives the
 * server's own authorization URL and nothing else.
 *
 * The transport is installed, but the *binding* stays disabled by default, so
 * this object is not deployed at all until an operator stages it and the canary
 * passes.
 *
 * D1 remains the authority for the connection's identity, its owner, and its
 * status. Every use rechecks it.
 */
export class McpConnectionDO extends DurableObject<McpConnectionBindings> {
  private connectionId: string | undefined;
  private ownerUserId: string | undefined;
  private readonly mcp = new MCPClientManager("open-inspect-mcp", "0.1.0", {
    createAuthProvider: (callbackUrl) => {
      if (!this.connectionId || !this.ownerUserId) {
        throw new Error("MCP broker identity has not been initialized from D1");
      }
      return new EncryptedMcpOAuthClientProvider({
        storage: new D1McpOAuthStorage(
          // eslint-disable-next-line no-restricted-syntax -- Durable Object composition root creates the encrypted D1 adapter
          this.env.DB,
          // A rotated keyring in D1 wins, so a rotation needs no code change.
          // eslint-disable-next-line no-restricted-syntax -- Durable Object composition root resolves the keyring
          () => resolveMcpOAuthKeyring(this.env.DB, requireMcpOAuthEncryptionKey(this.env)),
          this.connectionId
        ),
        clientName: "open-inspect-mcp",
        callbackUrl,
      });
    },
  });

  /**
   * The lifecycle that owns the client's lifecycle.
   *
   * The manager is a capability, so it is installed on one: that is what
   * restores the persisted connections on a cold start and what serves the
   * server's OAuth callback.
   */
  private readonly lifecycle = Lifecycle.install(this).use(this.mcp);

  async initialize(connectionId: string, ownerUserId: string): Promise<void> {
    if (!/^mcpconn_[a-f0-9]{32}$/.test(connectionId)) throw new Error("Invalid MCP connection id");
    await this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get<BrokerTombstone>(DELETED_KEY)) {
        throw new Error("MCP connection broker has been deleted");
      }
      const [storedConnectionId, storedOwnerUserId] = await Promise.all([
        this.ctx.storage.get<string>(CONNECTION_ID_KEY),
        this.ctx.storage.get<string>(OWNER_USER_ID_KEY),
      ]);
      if (
        (storedConnectionId && storedConnectionId !== connectionId) ||
        (storedOwnerUserId && storedOwnerUserId !== ownerUserId)
      ) {
        throw new Error("MCP broker is already bound to a different connection or owner");
      }
      // eslint-disable-next-line no-restricted-syntax -- Durable Object identity is verified against D1 authority at its composition boundary
      const authority = await this.env.DB.prepare(
        "SELECT owner_user_id, status FROM mcp_connections WHERE id = ?"
      )
        .bind(connectionId)
        .first<{ owner_user_id: string; status: string }>();
      if (
        !authority ||
        authority.owner_user_id !== ownerUserId ||
        authority.status === "revoking"
      ) {
        throw new Error("MCP connection identity is not authorized by D1");
      }
      await this.ctx.storage.put({
        [CONNECTION_ID_KEY]: connectionId,
        [OWNER_USER_ID_KEY]: ownerUserId,
      });
      this.connectionId = connectionId;
      this.ownerUserId = ownerUserId;
    });
  }

  /**
   * Whether the manager has a registration table in this Durable Object.
   *
   * The table is created when the lifecycle starts, so a broker that never
   * started never had a registration to remove.
   */
  private async mcpRegistrationExists(): Promise<boolean> {
    const tables = await this.lifecycle.sql<{ name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'cf_agents_mcp_servers'
    `;
    return tables.length > 0;
  }

  /**
   * The lifecycle has to be running before the manager's own storage is used.
   *
   * The manager creates its registration table when the lifecycle starts, and
   * a Durable Object RPC method bypasses the runtime's fetch entry point, so
   * the startup is explicit here. The lifecycle shares one startup between
   * concurrent callers, so the extra call is free after the first one.
   */
  private async ensureStarted(): Promise<void> {
    await this.lifecycle.start();
  }

  async status(): Promise<{
    enabled: boolean;
    connectionId: string;
    ownerUserId: string;
    transportCacheEntries: number;
    reason: string;
    /**
     * Where the owner must go to finish the server's authorization.
     *
     * It is the server's own authorization URL, never a credential.
     */
    authUrl?: string;
    state?: McpConnectionTransportState;
  }> {
    await this.ensureStarted();
    const connectionId =
      this.connectionId ?? (await this.ctx.storage.get<string>(CONNECTION_ID_KEY));
    const ownerUserId = this.ownerUserId ?? (await this.ctx.storage.get<string>(OWNER_USER_ID_KEY));
    if (!connectionId || !ownerUserId) throw new Error("MCP broker identity is not initialized");
    // eslint-disable-next-line no-restricted-syntax -- every broker use rechecks the D1 credential/ownership authority
    const authority = await this.env.DB.prepare(
      "SELECT owner_user_id FROM mcp_connections WHERE id = ?"
    )
      .bind(connectionId)
      .first<{ owner_user_id: string }>();
    if (!authority || authority.owner_user_id !== ownerUserId) {
      throw new Error("MCP broker identity is no longer authorized by D1");
    }
    this.connectionId = connectionId;
    this.ownerUserId = ownerUserId;
    const live = this.liveTransportState(connectionId);
    const usable = live.state === "ready" || live.state === "connected";
    return {
      enabled: usable,
      connectionId,
      ownerUserId,
      transportCacheEntries: this.mcp.listServers().length,
      reason: live.state
        ? `The MCP transport is ${live.state}`
        : "The MCP transport has not been opened yet",
      ...(live.authUrl ? { authUrl: live.authUrl } : {}),
      ...(live.state ? { state: live.state } : {}),
    };
  }

  /**
   * Make one connection usable for its owner.
   *
   * The broker opens the transport against the reviewed endpoint. When the
   * server wants the owner's approval, the broker returns the server's own
   * authorization URL and records that the connection is waiting for its
   * owner; the owner visits the URL and the server sends the callback back to
   * this broker. The credential never leaves the broker.
   *
   * `reconnect` discards the stored credential first. It is the owner's
   * explicit act, and it is the only way a credential the provider has
   * refused can be replaced.
   */
  async authorize(
    connectionId: string,
    ownerUserId: string,
    options?: { reconnect?: boolean }
  ): Promise<McpConnectionAuthorization> {
    await this.ensureStarted();
    await this.requireIdentity(connectionId, ownerUserId);
    const authority = await this.requireD1Authority(connectionId, ownerUserId);
    if (authority.status === "revoking" || authority.status === "revoked") {
      throw new Error("MCP connection is no longer usable");
    }
    if (options?.reconnect) {
      // The owner's explicit act: the stored credential and the pending
      // authorization are discarded before a fresh one is started.
      await this.mcp.removeServer(connectionId);
    }
    const authorization = await this.openTransport(connectionId);
    await this.recordTransportStatus(
      connectionId,
      ownerUserId,
      await this.durableStatusFor(connectionId, authorization)
    );
    return authorization;
  }

  /**
   * The durable state the owner's view reads.
   *
   * A connection that reached the server and holds a credential is
   * authorized; a connection that reached the server without one needed no
   * approval; a connection the server is waiting on is waiting on its owner.
   */
  private async durableStatusFor(
    connectionId: string,
    authorization: McpConnectionAuthorization
  ): Promise<McpTransportStatus> {
    if (authorization.state === "authenticating") return "oauth_authorizing";
    if (authorization.state === "failed") return "failed";
    return (await this.hasStoredCredential(connectionId)) ? "oauth_ready" : "transport_ready";
  }

  /**
   * Whether the broker holds a credential for this connection.
   *
   * The credential is only ever read, never copied: the fact that it exists
   * is the answer.
   */
  private async hasStoredCredential(connectionId: string): Promise<boolean> {
    const provider = this.mcp.mcpConnections[connectionId]?.options.transport.authProvider;
    if (!provider) return false;
    try {
      return (await provider.tokens?.()) !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * The transport state the manager holds right now.
   *
   * It is the broker's own observation: the manager restores the registration
   * after a cold start, so this reports what the broker actually has.
   */
  private liveTransportState(connectionId: string): {
    state?: McpConnectionTransportState;
    authUrl?: string;
  } {
    const connection = this.mcp.mcpConnections[connectionId];
    const state = connection ? transportStateOf(connection.connectionState) : undefined;
    const authUrl = safeAuthorizationUrl(
      connection?.options.transport.authProvider?.authUrl ??
        this.mcp.listServers().find((server) => server.id === connectionId)?.auth_url
    );
    return { state, authUrl };
  }

  /**
   * Read one reviewed tool.
   *
   * The broker is the last authority before the provider. It rechecks the
   * owner, the connection's status, and the reviewed catalog from D1, so a
   * connection that was revoked or a tool that was never reviewed cannot
   * reach the provider even if the caller asked for it.
   */
  async callTool(call: McpBrokerCall): Promise<McpBrokerCallResult> {
    await this.ensureStarted();
    await this.requireIdentity(call.connectionId, call.ownerUserId);
    const authority = await this.requireD1Authority(call.connectionId, call.ownerUserId);
    if (authority.status === "revoking" || authority.status === "revoked") {
      throw new Error("MCP connection is no longer usable");
    }
    // eslint-disable-next-line no-restricted-syntax -- the reviewed catalog is D1 authority
    const reviewed = await this.env.DB.prepare(
      `SELECT 1 FROM mcp_connection_tool_snapshots
       WHERE connection_id = ? AND tool_name = ? AND effect = 'external_read'`
    )
      .bind(call.connectionId, call.toolName)
      .first();
    if (!reviewed) {
      throw new Error("MCP tool is not part of the reviewed read-only catalog");
    }
    // The transport. The credential stays in the broker: the agent never
    // sees it, and the answer is bounded before it leaves.
    const result = await this.callReviewedTool(call);
    return { content: result.content, truncated: result.truncated };
  }

  /**
   * The broker's own identity, checked against the call.
   *
   * The identity lives in the Durable Object's own storage, and it is only
   * ever the one D1 authorized.
   */
  private async requireIdentity(connectionId: string, ownerUserId: string): Promise<void> {
    const storedConnectionId =
      this.connectionId ?? (await this.ctx.storage.get<string>(CONNECTION_ID_KEY));
    const storedOwnerUserId =
      this.ownerUserId ?? (await this.ctx.storage.get<string>(OWNER_USER_ID_KEY));
    if (!storedConnectionId || !storedOwnerUserId) {
      throw new Error("MCP broker identity is not initialized");
    }
    if (storedConnectionId !== connectionId || storedOwnerUserId !== ownerUserId) {
      throw new Error("MCP broker identity does not match the call");
    }
    this.connectionId = storedConnectionId;
    this.ownerUserId = storedOwnerUserId;
  }

  /**
   * The D1 authority for one connection.
   *
   * Every use rechecks it: a connection whose owner changed, or that the owner
   * removed, stops working even if the broker still holds its state.
   */
  private async requireD1Authority(
    connectionId: string,
    ownerUserId: string
  ): Promise<{ owner_user_id: string; status: string }> {
    // eslint-disable-next-line no-restricted-syntax -- every broker use rechecks the D1 credential/ownership authority
    const authority = await this.env.DB.prepare(
      `SELECT owner_user_id, status FROM mcp_connections WHERE id = ?`
    )
      .bind(connectionId)
      .first<{ owner_user_id: string; status: string }>();
    if (!authority || authority.owner_user_id !== ownerUserId) {
      throw new Error("MCP broker identity is no longer authorized by D1");
    }
    return authority;
  }

  /**
   * Record the transport state of one connection in D1.
   *
   * D1 is the authority the owner's view reads, so the state the broker
   * observed is written there rather than kept in memory.
   */
  private async recordTransportStatus(
    connectionId: string,
    ownerUserId: string,
    status: McpTransportStatus
  ): Promise<void> {
    // eslint-disable-next-line no-restricted-syntax -- Durable Object composition root resolves the D1 authority it writes
    await new McpConnectionStore(this.env.DB).setTransportStatus(connectionId, ownerUserId, status);
  }

  /**
   * Call one reviewed tool on the server.
   *
   * The connection is opened if it is not open yet, and the answer is cut
   * to the bound the broker allows. The provider's own error never leaves
   * the broker: the caller learns that the read did not complete.
   */
  private async callReviewedTool(call: McpBrokerCall): Promise<McpBrokerCallResult> {
    const serverId = call.connectionId;
    await this.ensureServerRegistered(serverId);
    const connection = this.mcp.mcpConnections[serverId];
    if (!connection) throw new Error("MCP connection is unavailable");
    if (connection.connectionState !== "ready" && connection.connectionState !== "connected") {
      // The transport is not usable yet. When the server is already waiting
      // for the owner's approval, the pending authorization is left exactly
      // as it is: a read must not replace the owner's URL.
      const live = this.liveTransportState(serverId);
      const opened =
        live.state === "authenticating"
          ? { state: "authenticating" as const, authUrl: live.authUrl }
          : await this.openTransport(serverId);
      // The owner has to be told what the connection is waiting for, so the
      // state is recorded before the read is refused.
      await this.recordTransportStatus(
        serverId,
        call.ownerUserId,
        await this.durableStatusFor(serverId, opened)
      );
      throw new Error(
        opened.state === "authenticating"
          ? "MCP connection is not authorized yet"
          : "MCP connection is not ready"
      );
    }
    let result: Awaited<ReturnType<typeof connection.client.callTool>>;
    try {
      result = await this.mcp.callTool(
        { serverId, name: call.toolName, arguments: call.arguments },
        { timeout: MCP_TOOL_TIMEOUT_MS }
      );
    } catch {
      // The provider's own string stays in the broker.
      throw new Error("The MCP tool did not complete");
    }
    return { content: result.content ?? null, truncated: false };
  }

  /**
   * Open the transport to the reviewed server.
   *
   * The registration is the server's own identity and its callback URL; the
   * connection is opened with the encrypted OAuth provider, so the token
   * never leaves the broker's memory or its encrypted D1 rows. When the server
   * wants the owner's approval, the result carries the server's own
   * authorization URL, which is a URL and never a credential.
   *
   * A handshake that is already waiting for the owner is restarted, so the URL
   * the owner receives is always one they can still use: the provider's state
   * is single-use and short-lived, and a stale URL would fail the callback.
   * The owner is the only one who triggers this, so nothing else disturbs a
   * pending authorization.
   */
  private async openTransport(connectionId: string): Promise<McpConnectionAuthorization> {
    await this.ensureServerRegistered(connectionId);
    const connection = this.mcp.mcpConnections[connectionId];
    if (!connection) throw new Error("MCP connection is unavailable");
    const live = this.liveTransportState(connectionId);
    if (live.state === "ready" || live.state === "connected") {
      return { state: live.state };
    }
    const connected = await withTimeout(
      this.mcp.connectToServer(connectionId),
      MCP_AUTHORIZE_TIMEOUT_MS
    );
    if (connected.state === "connected") return { state: "connected" };
    if (connected.state === "authenticating") {
      const authUrl = safeAuthorizationUrl(connected.authUrl);
      // A server that names an authorization page the owner's browser may not
      // be sent to gets no URL at all: the owner is not sent to a plaintext
      // page and not to a script URL.
      if (!authUrl) return { state: "failed" };
      return { state: "authenticating", authUrl };
    }
    // The provider's own error string stays in the broker.
    return { state: "failed" };
  }

  /**
   * Make sure the server is registered.
   *
   * The registration is the server's own identity and its callback URL; the
   * connection itself is opened by `openTransport`, so the owner's
   * authorization attempt and a reviewed read share one path.
   */
  private async ensureServerRegistered(connectionId: string): Promise<string> {
    if (this.mcp.mcpConnections[connectionId]) return connectionId;
    // eslint-disable-next-line no-restricted-syntax -- the broker re-reads the D1 connection authority on every use
    const row = await this.env.DB.prepare(
      `SELECT endpoint_url, server_name FROM mcp_connections WHERE id = ?`
    )
      .bind(connectionId)
      .first<{ endpoint_url: string; server_name: string }>();
    if (!row) throw new Error("MCP connection is not authorized by D1");
    await this.mcp.registerServer(connectionId, {
      url: row.endpoint_url,
      name: row.server_name,
      callbackUrl: mcpCallbackUrl(this.env, connectionId),
    });
    return connectionId;
  }

  /**
   * The lifecycle start.
   *
   * The manager restores its persisted connections here, so a cold broker
   * picks up the server it already knew.
   */
  async onStart(): Promise<void> {
    await this.lifecycle.start();
  }

  /**
   * The server's OAuth callback.
   *
   * The broker owns the connection and the token, so the callback is
   * handled here and nowhere else. The outcome is recorded in D1 before the
   * owner is sent back, so the owner's view is never behind the browser.
   */
  async handleCallback(request: Request): Promise<Response> {
    const response = await this.lifecycle.fetch(request);
    // A request the manager did not recognize as a callback is not a
    // callback outcome, so it never moves the connection's state.
    if (response.status !== 404) {
      await this.recordCallbackOutcome();
      const target = this.ownerReturnUrl();
      if (target) return Response.redirect(target);
    }
    return response;
  }

  /**
   * Record what the server's callback did.
   *
   * The provider's answer is never read: the credential's own presence is
   * the fact. A stored credential means the owner approved the server; no
   * credential means the approval did not complete.
   */
  private async recordCallbackOutcome(): Promise<void> {
    const connectionId =
      this.connectionId ?? (await this.ctx.storage.get<string>(CONNECTION_ID_KEY));
    const ownerUserId = this.ownerUserId ?? (await this.ctx.storage.get<string>(OWNER_USER_ID_KEY));
    if (!connectionId || !ownerUserId) return;
    const connection = this.mcp.mcpConnections[connectionId];
    const provider = connection?.options.transport.authProvider;
    let tokens: unknown;
    try {
      tokens = await provider?.tokens?.();
    } catch {
      tokens = undefined;
    }
    await this.recordTransportStatus(connectionId, ownerUserId, tokens ? "oauth_ready" : "failed");
  }

  /**
   * Where the owner lands after the server's callback.
   *
   * It is the owner's own place in the web app, so the approval ends where
   * the connection is managed. The provider's own words never reach the URL.
   */
  private ownerReturnUrl(): string | undefined {
    const base = this.env.WEB_APP_URL?.trim();
    if (!base) return undefined;
    return `${base.replace(/\/+$/, "")}/settings?tab=mcp-servers`;
  }

  /**
   * The broker's own HTTP surface.
   *
   * It exists for one reason: the server sends the owner back here after an
   * OAuth approval, and the manager handles that callback. Nothing else is
   * reachable here.
   */
  async fetch(request: Request): Promise<Response> {
    return this.lifecycle.fetch(request);
  }

  async destroy(connectionId: string, ownerUserId: string): Promise<void> {
    const tombstone = await this.ctx.storage.get<BrokerTombstone>(DELETED_KEY);
    if (tombstone) {
      if (tombstone.connectionId !== connectionId || tombstone.ownerUserId !== ownerUserId) {
        throw new Error("MCP broker tombstone belongs to a different connection or owner");
      }
      return;
    }
    const [storedConnectionId, storedOwnerUserId] = await Promise.all([
      this.ctx.storage.get<string>(CONNECTION_ID_KEY),
      this.ctx.storage.get<string>(OWNER_USER_ID_KEY),
    ]);
    if (
      (storedConnectionId && storedConnectionId !== connectionId) ||
      (storedOwnerUserId && storedOwnerUserId !== ownerUserId)
    ) {
      throw new Error("MCP broker deletion targeted a different connection or owner");
    }
    // eslint-disable-next-line no-restricted-syntax -- revocation reauthorizes its durable D1 checkpoint before cleanup
    const authority = await this.env.DB.prepare(
      "SELECT owner_user_id, status FROM mcp_connections WHERE id = ?"
    )
      .bind(connectionId)
      .first<{ owner_user_id: string; status: string }>();
    if (!authority || authority.owner_user_id !== ownerUserId || authority.status !== "revoking") {
      throw new Error("MCP broker revocation is not authorized by D1");
    }
    await this.mcp.closeAllConnections();
    // The manager's own registration lives in the Durable Object's SQLite, not
    // in its key-value storage, so the row is removed explicitly. It holds no
    // credential, but a revoked connection must leave nothing behind. The
    // manager only ever has a registration once the lifecycle has started, and
    // the lifecycle creates the table the removal needs, so a broker that never
    // started has nothing to remove.
    if (await this.mcpRegistrationExists()) {
      await this.mcp.removeServer(connectionId);
    }
    // eslint-disable-next-line no-restricted-syntax -- binding-only broker cleanup removes encrypted OAuth rows before D1 connection deletion
    await this.env.DB.prepare("DELETE FROM mcp_oauth_storage WHERE connection_id = ?")
      .bind(connectionId)
      .run();
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put(DELETED_KEY, {
      connectionId,
      ownerUserId,
    } satisfies BrokerTombstone);
    this.connectionId = undefined;
    this.ownerUserId = undefined;
  }
}

/**
 * The authorization URL the owner's browser may be sent to.
 *
 * It has to be an HTTPS page: a server that names a plaintext page, or a
 * script URL, gets no URL at all rather than a URL the owner would follow.
 */
function safeAuthorizationUrl(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  return url.protocol === "https:" ? url.toString() : undefined;
}

/**
 * The owner-facing transport state of one connection.
 */
function transportStateOf(state: string): McpConnectionTransportState | undefined {
  switch (state) {
    case "authenticating":
      return "authenticating";
    case "connecting":
      return "connecting";
    case "connected":
    case "discovering":
      return "connected";
    case "ready":
      return "ready";
    case "failed":
      return "failed";
    default:
      return undefined;
  }
}

/**
 * Bound one promise.
 *
 * The owner's request must not hang on a server that never answers, and the
 * work that is still running is the broker's own.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("The MCP transport did not answer")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
