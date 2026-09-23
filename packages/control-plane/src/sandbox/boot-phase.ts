import {
  sandboxBootPhaseSchema,
  type SandboxBootPhase,
} from "@open-inspect/shared/types/sandbox-events";

/** Parse the persisted JSON representation of the latest sandbox boot phase. */
export function parseStoredSandboxBootPhase(value: string | null): SandboxBootPhase | null {
  if (!value) return null;
  try {
    const parsed = sandboxBootPhaseSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Canonical structured-log representation of a sandbox boot phase. */
export function sandboxBootPhaseLogFields(phase: SandboxBootPhase | null) {
  return {
    boot_seq: phase?.bootSeq ?? null,
    phase: phase?.phase ?? null,
    phase_status: phase?.status ?? null,
    repo_owner: phase?.repoOwner ?? null,
    repo_name: phase?.repoName ?? null,
    elapsed_ms: phase?.elapsedMs ?? null,
    warning: phase?.warning ?? false,
  };
}
