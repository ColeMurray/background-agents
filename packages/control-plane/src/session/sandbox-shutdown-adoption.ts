import { supportsConfirmedShutdown } from "../sandbox/lifecycle/shutdown-policy";
import type { SandboxRow } from "./types";
import type { ShutdownRecord } from "./sandbox-shutdown-repository";

/**
 * The record for a generation the coordinator never started.
 *
 * `reserveStartup` is the only writer of an initial record and runs on spawn,
 * restore and resume, so a sandbox already serving when this coordinator was
 * deployed has no state at all. Nothing then assigns it a lifetime or schedules
 * a capture, and `requestShutdown` reports it `unmanaged`, so the ordered
 * shutdown whose whole purpose is to guarantee a recovery point never applies
 * to it.
 *
 * The adopted record is always `legacy`, whatever the runtime version says it
 * could support, and this is load-bearing rather than merely cautious. The
 * ordered protocol needs two facts adoption cannot supply: the generation
 * handshake (which happened before this coordinator existed) and the provider
 * lifetime (which only a launch result carries). Without them a `confirmed`
 * record fails the admission gate's `lifetimeKind !== "unknown" &&
 * generationReady` test and holds every dispatch, so adopting a healthy session
 * would stop it working. `legacy` admits work and routes shutdown to the
 * snapshot path, which does preserve state.
 *
 * Only a serving generation is adopted. Every other status either already has a
 * record — a spawn writes one before the provider is invoked — or is on its way
 * out, where the spawn decision and the watchdogs are the owners.
 *
 * So adoption buys observability and an owner, not a deadline capture: a
 * generation whose provider lifetime expires before it next idles still has no
 * drain scheduled. Closing that needs either a provider capability to read a
 * running sandbox's lifetime, or a capture-and-replace sweep at activation.
 */
export function adoptedShutdownRecord(
  row: SandboxRow | null,
  providerName: string
): ShutdownRecord | null {
  if (!row?.modal_sandbox_id || row.status !== "ready") return null;
  return {
    phase: "running",
    generation: { sandboxId: row.modal_sandbox_id, createdAt: row.created_at },
    provider: providerName,
    providerObjectId: row.modal_object_id ?? null,
    sourceRetired: false,
    lifetimeKind: "unknown",
    expiresAtMs: null,
    drainAtMs: null,
    generationReady: false,
    lifecyclePolicy: "legacy",
  };
}

/**
 * Structured provenance for an adoption. This is the only record that a
 * generation was adopted rather than started: the persisted state deliberately
 * carries no flag for it, because nothing in production would branch on one and
 * an optional boolean would widen the durable compatibility surface to describe
 * something the log already says.
 */
export function adoptionLogFields(row: SandboxRow): Record<string, unknown> {
  return {
    event: "sandbox.preservation_adopted",
    sandbox_id: row.modal_sandbox_id,
    sandbox_status: row.status,
    runtime_version: row.runtime_version,
    // Recorded so a deploy that orphans a protocol-capable generation stays
    // distinguishable from one that never could have participated.
    runtime_supports_confirmed_shutdown: supportsConfirmedShutdown(row.runtime_version),
  };
}
