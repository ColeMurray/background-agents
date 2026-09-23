import type { ShutdownRecord } from "./sandbox-shutdown-repository";
import type { SandboxRow } from "./types";

/**
 * Initial ownership for an operation on legacy state, never periodic adoption.
 * A stored sandbox row proves identity, not lifetime, handshake, or a recovery
 * receipt. Only a provider operation may supply those missing facts.
 */
export function legacyShutdownRecord(row: SandboxRow, provider: string): ShutdownRecord {
  if (!row.modal_sandbox_id) throw new Error("Cannot own a sandbox without a generation");
  return {
    phase: "running",
    generation: { sandboxId: row.modal_sandbox_id, createdAt: row.created_at },
    provider,
    providerObjectId: row.modal_object_id,
    sourceRetired: false,
    lifetimeKind: "unknown",
    expiresAtMs: null,
    drainAtMs: null,
    generationReady: false,
    lifecyclePolicy: "legacy",
  };
}
