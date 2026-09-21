import { parseStoredSandboxBootPhase } from "../boot-phase";

/**
 * The operator-facing explanation for a boot that outlived its budget.
 *
 * Kept out of the alarm policy: the policy decides that the budget was
 * exceeded, this decides how to say so. Naming both the phase and the knob
 * means the reader of a failed session learns which boot step hung and what
 * to change, without going to the logs.
 */
export function formatBootBudgetFailure(bootPhaseJson: string | null, timeoutMs: number): string {
  const budgetMinutes = Math.round(timeoutMs / 60_000);
  return (
    `Sandbox boot exceeded ${budgetMinutes} minutes while ${describeBootPhase(bootPhaseJson)}. ` +
    "Raise SANDBOX_BOOT_TIMEOUT_MS if the boot legitimately needs longer, or make it return sooner."
  );
}

/**
 * Name the script where possible so operators know which boot step to inspect.
 *
 * The column holds whatever the runtime last reported, so an unparseable or
 * unrecognised value degrades to the generic "booting" rather than failing the
 * failure path.
 */
function describeBootPhase(bootPhaseJson: string | null): string {
  const phase = parseStoredSandboxBootPhase(bootPhaseJson);
  if (!phase) return "booting";
  const repo = phase.repoOwner && phase.repoName ? ` for ${phase.repoOwner}/${phase.repoName}` : "";
  switch (phase.phase) {
    case "starting":
      return "starting the runtime";
    case "sync":
      return `cloning${repo}`;
    case "setup":
      return `running setup.sh${repo}`;
    case "start":
      return `running start.sh${repo}`;
    case "skills":
      return "installing managed skills";
    case "harness":
      return "starting the agent";
  }
}
