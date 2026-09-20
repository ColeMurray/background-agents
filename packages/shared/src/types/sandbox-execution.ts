import { z } from "zod";

/** Versioned filesystem/runtime contracts, not infrastructure provider names. */
export const sandboxExecutionProfileSchema = z.enum(["default", "docker-v1"]);
export type SandboxExecutionProfile = z.infer<typeof sandboxExecutionProfileSchema>;

export const DEFAULT_DOCKER_CPU_CORES = 2;
export const DEFAULT_DOCKER_MEMORY_MIB = 4096;

export const sessionSandboxExecutionSchema = z.discriminatedUnion("profile", [
  z.strictObject({ profile: z.literal("default") }),
  z.strictObject({
    profile: z.literal("docker-v1"),
    provider: z.literal("modal"),
    cpuCores: z.number().finite().positive(),
    memoryMib: z.number().int().positive(),
  }),
]);
export type SessionSandboxExecution = z.infer<typeof sessionSandboxExecutionSchema>;

export const snapshotRecoveryErrorCodeSchema = z.enum([
  "profile_mismatch",
  "runtime_incompatible",
  "artifact_missing",
  "invalid_snapshot_metadata",
]);
export type SnapshotRecoveryErrorCode = z.infer<typeof snapshotRecoveryErrorCodeSchema>;

/** Missing pre-feature metadata is default; malformed present metadata is never default. */
export function parseSessionSandboxExecution(
  raw: string | null | undefined
): SessionSandboxExecution {
  return raw == null
    ? { profile: "default" }
    : sessionSandboxExecutionSchema.parse(JSON.parse(raw));
}
