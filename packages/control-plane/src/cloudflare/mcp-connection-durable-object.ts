import { DurableObject } from "cloudflare:workers";
import { MCPClientManager } from "agents/mcp/client";
import { requireMcpOAuthEncryptionKey } from "../env-validation";
import {
  D1McpOAuthStorage,
  EncryptedMcpOAuthClientProvider,
} from "../mcp/encrypted-oauth-provider";
import type { WorkerBindings } from "./platform";

type McpConnectionBindings = Pick<WorkerBindings, "DB" | "MCP_OAUTH_ENCRYPTION_KEY">;
const CONNECTION_ID_KEY = "open-inspect:mcp-connection-id";
const OWNER_USER_ID_KEY = "open-inspect:mcp-owner-user-id";
const DELETED_KEY = "open-inspect:mcp-deleted";

/**
 * Dormant per-connection MCP broker foundation.
 *
 * The manager deliberately is not installed on a Lifecycle yet: no persisted
 * registration is restored, no callback is accepted, and no network
 * connection or tool call can start in this slice. Installing the capability
 * is a separate live-transport canary gate. D1 remains authoritative; the
 * Agents `cf_agents_mcp_servers` table may later cache reconstructable
 * transport registrations only.
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
          requireMcpOAuthEncryptionKey(this.env),
          this.connectionId
        ),
        clientName: "open-inspect-mcp",
        callbackUrl,
      });
    },
  });

  async initialize(connectionId: string, ownerUserId: string): Promise<void> {
    if (!/^mcpconn_[a-f0-9]{32}$/.test(connectionId)) throw new Error("Invalid MCP connection id");
    await this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get<boolean>(DELETED_KEY)) {
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
        "SELECT owner_user_id FROM mcp_connections WHERE id = ?"
      )
        .bind(connectionId)
        .first<{ owner_user_id: string }>();
      if (!authority || authority.owner_user_id !== ownerUserId) {
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

  async status(): Promise<{
    enabled: false;
    connectionId: string;
    ownerUserId: string;
    transportCacheEntries: number;
    reason: string;
  }> {
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
    return {
      enabled: false,
      connectionId,
      ownerUserId,
      // The manager is intentionally not installed, so no transport cache can exist.
      transportCacheEntries: 0,
      reason: "Live MCP transport is not enabled",
    };
  }

  async destroy(connectionId: string): Promise<void> {
    const status = await this.status();
    if (status.connectionId !== connectionId) {
      throw new Error("MCP broker deletion targeted a different connection");
    }
    await this.mcp.closeAllConnections();
    // eslint-disable-next-line no-restricted-syntax -- binding-only broker cleanup removes encrypted OAuth rows before D1 connection deletion
    await this.env.DB.prepare("DELETE FROM mcp_oauth_storage WHERE connection_id = ?")
      .bind(connectionId)
      .run();
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put(DELETED_KEY, true);
    this.connectionId = undefined;
    this.ownerUserId = undefined;
  }
}
