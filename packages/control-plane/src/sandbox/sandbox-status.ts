import { sandboxStatusSchema, type SandboxStatus } from "@open-inspect/shared/types/sessions";
import type { Logger } from "../logger";

/**
 * Turn a raw sandbox status read out of storage into a `SandboxStatus`.
 *
 * Both status columns are bare `TEXT` with a default and no `CHECK`
 * constraint, so a row's status is only a `SandboxStatus` by convention. Every
 * write path is typed, which is what actually keeps the column honest — this
 * exists so the read side degrades loudly instead of asserting a lie with
 * `as SandboxStatus`.
 *
 * Degrades rather than throws on purpose: the callers are spawn evaluation and
 * alarm ticks, which can proceed sensibly from `pending`. A throw there would
 * abort real work over a value the caller could have survived. Write
 * boundaries should stay compile-time typed instead of parsing.
 */
export function coerceSandboxStatus(raw: string | null | undefined, log: Logger): SandboxStatus {
  // Absent is the documented pre-spawn state, not corruption — no warning.
  if (raw == null || raw === "") return "pending";

  const parsed = sandboxStatusSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  log.warn("sandbox.status.unrecognized", {
    event: "sandbox.status.unrecognized",
    status: raw,
  });
  return "pending";
}
