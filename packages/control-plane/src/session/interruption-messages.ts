/** User-facing text for a prompt interrupted by a shutdown; reasons are internal codes. */
const INTERRUPTION_MESSAGES: Record<string, string> = {
  heartbeat_timeout: "The sandbox stopped responding.",
  prompt_dispatch_send_failed: "The sandbox stopped responding.",
  stop_send_failed: "The sandbox stopped responding.",
  stop_alarm_failed: "The sandbox stopped responding.",
  stop_confirmation_timeout: "The sandbox stopped responding.",
  fatal_runtime_error: "The sandbox runtime failed.",
  inactivity_timeout: "The sandbox was stopped after a period of inactivity.",
  sandbox_lifetime_expiring: "The sandbox reached its maximum lifetime.",
};

/** What a prompt interrupted for `reason` reports to its author. */
export function interruptionMessage(reason: string): string {
  return INTERRUPTION_MESSAGES[reason] ?? "The sandbox was stopped.";
}
