import type {
  ManagedMcpExecution,
  RuntimeMcpServerConfig,
  McpAuthMode,
} from "@open-inspect/shared/types/integrations";
import type { SqlStorage } from "./sql-storage";
import type { SqlDatabase } from "../db/sql-database";
import type { SessionCoreRepository } from "./session-core-repository";
import type { SandboxStateReader } from "./sandbox-ports";
import { isValidSandboxToken } from "./sandbox-access";
import { McpConnectionStore, connectionBinding, type McpGrantBinding } from "../db/mcp-connections";
import { McpServerStore } from "../db/mcp-servers";
import { McpError, mcpErrorResponse } from "../mcp/errors";
import { assertMcpUserAccess } from "../mcp/authorization";
import { MCP_STREAM_TIMEOUT_MS, MCP_UPSTREAM_HEADERS_TIMEOUT_MS } from "../mcp/relay";
import type { Env } from "../types";
import { z } from "zod";

interface LaunchBinding {
  id: string;
  name: string;
  authMode: McpAuthMode;
  authRevision: number;
}
interface MessageContext {
  id: string;
  admitted_canonical_user_id: string | null;
  mcp_eligible: number;
  mcp_revision: number;
  mcp_context: string | null;
  mcp_closed: number;
}
export interface McpProxySnapshot {
  leaseId: string;
  serverId: string;
  serverAuthRevision: number;
  authMode: McpAuthMode;
  sandboxId: string;
  sandboxCreatedAt: number;
  repositories: { repoOwner: string; repoName: string }[];
  messageId?: string;
  revision?: number;
  grant?: McpGrantBinding;
}
interface PreparedContext {
  sandboxId: string;
  sandboxCreatedAt: number;
  bindings: McpGrantBinding[];
}
// A bridge process restart is not proof that its separately owned native server
// stopped. Only a fresh allocation launch can clear this durable fence.
const POISONED_RUNTIME_VERSION = -1;
// A lease must outlive the longest relayed request it admits, plus slack for
// the release round-trip after a stream ends.
const MCP_PROXY_LEASE_TTL_MS = MCP_UPSTREAM_HEADERS_TIMEOUT_MS + MCP_STREAM_TIMEOUT_MS + 60_000;
const requestSchema = z.object({
  serverId: z.string(),
  leaseId: z.string().uuid(),
  release: z.boolean().optional(),
  expected: z.record(z.string(), z.unknown()).optional(),
});

/** Extends the existing processing claim; never owns HTTP bodies, tokens or long streams. */
export class SessionMcpContext {
  constructor(
    private readonly sql: SqlStorage,
    private readonly db: SqlDatabase,
    private readonly env: Env,
    private readonly sessions: SessionCoreRepository,
    private readonly sandboxes: SandboxStateReader
  ) {}

  recordLaunch(servers: RuntimeMcpServerConfig[]): void {
    const allowed: LaunchBinding[] = servers.flatMap((server) =>
      "managed_proxy" in server
        ? [
            {
              id: server.id,
              name: server.name,
              authMode: server.managed_proxy.auth_mode,
              authRevision: server.managed_proxy.auth_revision,
            },
          ]
        : []
    );
    this.sql.exec(
      "UPDATE sandbox SET mcp_servers = ?, mcp_runtime_version = 0, mcp_bridge_instance_id = NULL",
      JSON.stringify(allowed)
    );
  }
  disableRuntime(): void {
    this.sql.exec("UPDATE sandbox SET mcp_runtime_version = ?", POISONED_RUNTIME_VERSION);
  }
  recordRuntimeVersion(version: number, bridgeInstanceId?: string): void {
    // A transport reconnect keeps the live bridge and its owned cleanup task.
    // A replacement (or legacy unidentified) bridge cannot attest that the
    // previous process disposed its native clients, even after authority closed.
    this.sql.exec(
      `UPDATE sandbox SET mcp_runtime_version = CASE
        WHEN mcp_runtime_version = ? OR (mcp_runtime_version = 1
          AND (? IS NULL OR mcp_bridge_instance_id IS NOT ? OR ? != 1) AND EXISTS (
          SELECT 1 FROM messages WHERE mcp_context IS NOT NULL
            AND (status = 'processing' OR stop_confirmation_deadline IS NOT NULL)
        )) THEN ? ELSE ? END, mcp_bridge_instance_id = ?
        WHERE fenced = 0 AND status IN ('spawning', 'connecting', 'ready', 'failed')`,
      POISONED_RUNTIME_VERSION,
      bridgeInstanceId ?? null,
      bridgeInstanceId ?? null,
      version,
      POISONED_RUNTIME_VERSION,
      version,
      bridgeInstanceId ?? null
    );
  }
  /**
   * The multiplayer fence: unless multiplayer delegation is on, a session in which
   * another person has an eligible prompt delegates for nobody. A child spawned
   * here inherits the same answer, so spawning cannot step around the fence.
   */
  mayDelegateFor(canonicalUserId: string): boolean {
    if (this.env.MCP_MULTIPLAYER_ENABLED === "true") return true;
    return !this.sql
      .exec(
        "SELECT id FROM messages WHERE mcp_eligible = 1 AND admitted_canonical_user_id IS NOT NULL AND admitted_canonical_user_id != ? LIMIT 1",
        canonicalUserId
      )
      .toArray().length;
  }
  private launch(): LaunchBinding[] {
    const row = this.sql.exec("SELECT mcp_servers FROM sandbox LIMIT 1").toArray()[0] as
      { mcp_servers: string | null } | undefined;
    return row?.mcp_servers ? JSON.parse(row.mcp_servers) : [];
  }
  private active(): MessageContext | null {
    return (
      (this.sql
        .exec(
          "SELECT id, admitted_canonical_user_id, mcp_eligible, mcp_revision, mcp_context, mcp_closed FROM messages WHERE status = 'processing' LIMIT 1"
        )
        .toArray()[0] as MessageContext | undefined) ?? null
    );
  }
  async prepare(messageId: string): Promise<ManagedMcpExecution> {
    const message = this.active();
    if (!message || message.id !== messageId) throw new McpError("mcp_context_changed", 409);
    const runtime = this.sql
      .exec("SELECT mcp_runtime_version FROM sandbox LIMIT 1")
      .toArray()[0] as { mcp_runtime_version: number } | undefined;
    const personal = this.launch().filter((entry) => entry.authMode === "user_oauth");
    const result: ManagedMcpExecution = {
      messageId,
      revision: message.mcp_revision,
      servers: [],
      unavailable: [],
    };
    if (!personal.length) return result;
    try {
      result.connectionUrl = new URL(
        "/settings?tab=mcp-connections",
        this.env.WEB_APP_URL
      ).toString();
    } catch {
      // Without a parseable web origin the runtime falls back to a relative link.
    }
    const sandbox = this.sandboxes.getSandbox();
    const session = this.sessions.getSession();
    const bindings: McpGrantBinding[] = [];
    // The user/session check is identical for every personal server: run it once.
    let userAccess: Promise<void> | undefined;
    for (const entry of personal) {
      try {
        if (runtime?.mcp_runtime_version === POISONED_RUNTIME_VERSION)
          throw new McpError("mcp_runtime_restart_required");
        if (runtime?.mcp_runtime_version !== 1) throw new McpError("mcp_unsupported");
        if (!sandbox?.modal_sandbox_id || sandbox.status !== "ready" || sandbox.fenced || !session)
          throw new McpError("mcp_execution_inactive");
        if (
          this.env.MCP_USER_DELEGATION_ENABLED !== "true" ||
          !message.mcp_eligible ||
          !message.admitted_canonical_user_id
        )
          throw new McpError("mcp_execution_inactive");
        if (!this.mayDelegateFor(message.admitted_canonical_user_id))
          throw new McpError("mcp_unsupported");
        userAccess ??= assertMcpUserAccess(
          this.db,
          this.env,
          message.admitted_canonical_user_id,
          session.session_name || session.id
        );
        await userAccess;
        const server = await new McpServerStore(this.db, this.env.REPO_SECRETS_ENCRYPTION_KEY!).get(
          entry.id
        );
        if (
          !server?.enabled ||
          server.authRevision !== entry.authRevision ||
          server.authMode !== "user_oauth"
        )
          throw new McpError("mcp_context_changed", 409);
        const store = new McpConnectionStore(this.db, this.env.TOKEN_ENCRYPTION_KEY!);
        const row = await store.get(message.admitted_canonical_user_id, entry.id);
        if (!row) throw new McpError("mcp_connection_required");
        const binding = connectionBinding(row);
        await store.require(binding);
        if (binding.serverAuthRevision !== entry.authRevision)
          throw new McpError("mcp_reconnect_required");
        bindings.push(binding);
        result.servers.push(entry.name);
      } catch (error) {
        result.unavailable.push({
          name: entry.name,
          code: error instanceof McpError ? error.code : "mcp_unavailable",
        });
      }
    }
    const current = this.sandboxes.getSandbox();
    if (
      current?.modal_sandbox_id !== sandbox?.modal_sandbox_id ||
      current?.created_at !== sandbox?.created_at
    )
      throw new McpError("mcp_context_changed", 409);
    const context: PreparedContext = {
      sandboxId: sandbox?.modal_sandbox_id ?? "",
      sandboxCreatedAt: sandbox?.created_at ?? 0,
      bindings,
    };
    const rows = this.sql
      .exec(
        "UPDATE messages SET mcp_context = ? WHERE id = ? AND status = 'processing' AND mcp_revision = ? AND mcp_closed = 0 RETURNING id",
        JSON.stringify(context),
        messageId,
        message.mcp_revision
      )
      .toArray();
    if (rows.length !== 1) throw new McpError("mcp_context_changed", 409);
    return result;
  }
  private async authenticate(request: Request) {
    const before = this.sandboxes.getSandbox();
    const header = request.headers.get("Authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    if (!before?.modal_sandbox_id || !(await isValidSandboxToken(token, before)))
      throw new McpError("mcp_denied", 401);
    // Service/public clients may initialize before provider startup returns.
    // The reserved allocation and token must already match; personal use still
    // requires a separately prepared ready-runtime processing context.
    const current = this.sandboxes.getSandbox();
    if (
      !current ||
      current.modal_sandbox_id !== before.modal_sandbox_id ||
      current.created_at !== before.created_at ||
      current.auth_token_hash !== before.auth_token_hash ||
      current.auth_token !== before.auth_token ||
      current.fenced ||
      !["spawning", "ready", "connecting"].includes(current.status)
    )
      throw new McpError("mcp_context_changed", 409);
    return current;
  }
  async handle(request: Request): Promise<Response> {
    try {
      const input = requestSchema.parse(await request.json());
      const sandbox = await this.authenticate(request);
      if (input.release) {
        this.sql.exec(
          "DELETE FROM mcp_proxy_leases WHERE id = ? AND sandbox_id = ?",
          input.leaseId,
          sandbox.modal_sandbox_id!
        );
        return Response.json({ ok: true });
      }
      const session = this.sessions.getSession();
      if (!session || ["archived", "cancelled"].includes(session.status))
        throw new McpError("mcp_execution_inactive");
      const entry = this.launch().find((entry) => entry.id === input.serverId);
      if (!entry) throw new McpError("mcp_denied");
      if (!input.expected) {
        const now = Date.now();
        this.sql.exec(
          "UPDATE sandbox SET mcp_rate_count = 0, mcp_rate_window = ? WHERE mcp_rate_window <= ?",
          now,
          now - 60_000
        );
        const accepted = this.sql
          .exec(
            "UPDATE sandbox SET mcp_rate_count = mcp_rate_count + 1 WHERE mcp_rate_count < 120 RETURNING id"
          )
          .toArray();
        if (!accepted.length) throw new McpError("mcp_unavailable", 429);
      }
      const snapshot: McpProxySnapshot = {
        leaseId: input.leaseId,
        serverId: entry.id,
        serverAuthRevision: entry.authRevision,
        authMode: entry.authMode,
        sandboxId: sandbox.modal_sandbox_id!,
        sandboxCreatedAt: sandbox.created_at,
        repositories: this.sessions
          .getSessionRepositories()
          .map((r) => ({ repoOwner: r.repoOwner, repoName: r.repoName })),
      };
      if (entry.authMode === "user_oauth") {
        const runtime = this.sql
          .exec("SELECT mcp_runtime_version FROM sandbox LIMIT 1")
          .toArray()[0] as { mcp_runtime_version: number } | undefined;
        if (runtime?.mcp_runtime_version === POISONED_RUNTIME_VERSION)
          throw new McpError("mcp_runtime_restart_required");
        if (runtime?.mcp_runtime_version !== 1) throw new McpError("mcp_unsupported");
        if (this.env.MCP_USER_DELEGATION_ENABLED !== "true")
          throw new McpError("mcp_execution_inactive");
        const active = this.active();
        if (
          !active?.mcp_context ||
          active.mcp_closed ||
          !active.mcp_eligible ||
          !active.admitted_canonical_user_id
        )
          throw new McpError("mcp_execution_inactive");
        const prepared: PreparedContext = JSON.parse(active.mcp_context);
        if (
          prepared.sandboxId !== snapshot.sandboxId ||
          prepared.sandboxCreatedAt !== snapshot.sandboxCreatedAt
        )
          throw new McpError("mcp_context_changed", 409);
        const grant = prepared.bindings.find((b) => b.serverId === entry.id);
        if (!grant) throw new McpError("mcp_connection_required");
        if (grant.canonicalUserId !== active.admitted_canonical_user_id)
          throw new McpError("mcp_context_changed", 409);
        snapshot.messageId = active.id;
        snapshot.revision = active.mcp_revision;
        snapshot.grant = grant;
      } else if (this.env.MANAGED_MCP_ROUTING_ENABLED !== "true")
        throw new McpError("mcp_execution_inactive");
      if (input.expected && JSON.stringify(snapshot) !== JSON.stringify(input.expected))
        throw new McpError("mcp_context_changed", 409);
      const now = Date.now();
      this.sql.exec(
        "DELETE FROM mcp_proxy_leases WHERE expires_at <= ? OR sandbox_id != ?",
        now,
        sandbox.modal_sandbox_id!
      );
      if (!input.expected) {
        const leased = this.sql
          .exec(
            "INSERT INTO mcp_proxy_leases (id, sandbox_id, expires_at) SELECT ?, ?, ? WHERE (SELECT count(*) FROM mcp_proxy_leases) < 8 RETURNING id",
            input.leaseId,
            sandbox.modal_sandbox_id!,
            now + MCP_PROXY_LEASE_TTL_MS
          )
          .toArray();
        if (!leased.length) throw new McpError("mcp_unavailable", 429);
      } else if (
        !this.sql
          .exec(
            "SELECT id FROM mcp_proxy_leases WHERE id = ? AND sandbox_id = ?",
            input.leaseId,
            sandbox.modal_sandbox_id!
          )
          .toArray().length
      )
        throw new McpError("mcp_context_changed", 409);
      return Response.json(snapshot);
    } catch (error) {
      return mcpErrorResponse(error);
    }
  }
  async close(request: Request): Promise<Response> {
    try {
      const { messageId, revision } = z
        .object({ messageId: z.string(), revision: z.number().int().positive() })
        .parse(await request.json());
      await this.authenticate(request);
      this.sql.exec(
        "UPDATE messages SET mcp_closed = 1 WHERE id = ? AND mcp_revision = ?",
        messageId,
        revision
      );
      return Response.json({ ok: true });
    } catch (error) {
      return mcpErrorResponse(error);
    }
  }
}
