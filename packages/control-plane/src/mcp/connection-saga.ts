import type { McpConnectionMetadata } from "@open-inspect/shared/types/integrations";
import type { McpConnectionBrokerDispatch } from "./broker-contract";

export interface McpConnectionSagaAuthority {
  findOwnedByServer(ownerUserId: string, serverId: string): Promise<McpConnectionMetadata | null>;
  getOwnedForSaga(id: string, ownerUserId: string): Promise<McpConnectionMetadata | null>;
  create(ownerUserId: string, serverId: string): Promise<McpConnectionMetadata>;
  markRevoking(id: string, ownerUserId: string): Promise<McpConnectionMetadata | null>;
  deleteRevoking(id: string, ownerUserId: string): Promise<boolean>;
}

type BrokerLifecycle = Pick<McpConnectionBrokerDispatch, "initialize" | "destroy">;

/** Durable D1-checkpointed orchestration across connection metadata and its broker object. */
export class McpConnectionSaga {
  constructor(
    private readonly authority: McpConnectionSagaAuthority,
    private readonly broker: BrokerLifecycle
  ) {}

  async create(ownerUserId: string, serverId: string): Promise<McpConnectionMetadata> {
    const existing = await this.authority.findOwnedByServer(ownerUserId, serverId);
    if (existing) {
      if (existing.status === "revoking") {
        await this.completeRevocation(existing.id, ownerUserId);
      } else {
        await this.broker.initialize(existing.id, ownerUserId);
        return existing;
      }
    }

    const created = await this.authority.create(ownerUserId, serverId);
    try {
      await this.broker.initialize(created.id, ownerUserId);
      return created;
    } catch (initializeError) {
      const revoking = await this.authority.markRevoking(created.id, ownerUserId);
      if (revoking) {
        try {
          await this.completeRevocation(created.id, ownerUserId);
        } catch (cleanupError) {
          throw new AggregateError(
            [initializeError, cleanupError],
            "MCP broker initialization failed and compensation remains pending"
          );
        }
      }
      throw initializeError;
    }
  }

  async revoke(ownerUserId: string, connectionId: string): Promise<"deleted" | "already_deleted"> {
    const existing = await this.authority.getOwnedForSaga(connectionId, ownerUserId);
    if (!existing) return "already_deleted";
    if (existing.status !== "revoking") {
      const revoking = await this.authority.markRevoking(connectionId, ownerUserId);
      if (!revoking) return "already_deleted";
    }
    await this.completeRevocation(connectionId, ownerUserId);
    return "deleted";
  }

  private async completeRevocation(connectionId: string, ownerUserId: string): Promise<void> {
    await this.broker.destroy(connectionId, ownerUserId);
    await this.authority.deleteRevoking(connectionId, ownerUserId);
  }
}
