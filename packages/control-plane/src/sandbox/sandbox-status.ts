import { sandboxStatusSchema, type SandboxStatus } from "@open-inspect/shared/types/sessions";
import type { Logger } from "../logger";

/**
 * The status a sandbox holds before anything has tried to start it.
 *
 * Named because three places need the same answer -- a row whose status column
 * is empty, and the two callers that read a session with no sandbox row at all
 * -- and they should not be able to drift apart. The `sandbox` table declares
 * the matching SQL default (`session/schema.ts`), which cannot reference this
 * constant; if one changes, change both.
 *
 * Deliberately not exported from `@open-inspect/shared`: nothing outside the
 * control plane decides a sandbox's pre-spawn state.
 */
export const DEFAULT_SANDBOX_STATUS: SandboxStatus = "pending";

/**
 * Turn a raw sandbox status read out of storage into a `SandboxStatus`.
 *
 * Called from `SandboxRepository`, which is the single read boundary for the
 * sandbox row — not from individual consumers, or the same row would carry
 * different semantics depending on which accessor a caller used. Both status
 * columns are bare `TEXT` with no `CHECK` constraint, so a row's status is
 * only a `SandboxStatus` by convention; every write path is compile-time
 * typed, which is what actually keeps the column honest.
 *
 * Degrades rather than throws on purpose: the callers are spawn evaluation and
 * alarm ticks, which a throw would abort over a value they could survive.
 *
 * An unrecognized status resolves to `failed`, deliberately, and this is the
 * conservative choice rather than the obvious one. `pending` would let an
 * unclassifiable sandbox be treated as pre-spawn and picked up as if fresh;
 * `stopped` or `stale` would make `evaluateSpawnDecision` try to *resume* it.
 * `failed` is the only value that both refuses to reuse the sandbox and still
 * permits a clean spawn.
 */
export function coerceSandboxStatus(raw: string | null | undefined, log: Logger): SandboxStatus {
  // Absent is the documented pre-spawn state, not corruption.
  if (raw == null || raw === "") return DEFAULT_SANDBOX_STATUS;

  const parsed = sandboxStatusSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  log.warn("sandbox.status.unrecognized", {
    event: "sandbox.status.unrecognized",
    status: raw,
  });
  return "failed";
}
