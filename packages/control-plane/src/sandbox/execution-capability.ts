import runtimeManifest from "../../../sandbox-runtime/src/sandbox_runtime/runtime_manifest.json";
import { z } from "zod";

const providerSchema = z.enum(["modal", "modal-vm", "opencomputer", "daytona", "vercel", "e2b"]);
export type ExecutionProvider = z.infer<typeof providerSchema>;

export const executionCanaryEvidenceSchema = z
  .object({
    runtimeVersion: z.literal(runtimeManifest.runtimeVersion),
    artifactGeneration: z.number().int().min(78),
    artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
    networkProfile: z.literal("package-install-v1"),
    providers: z.record(
      providerSchema,
      z.discriminatedUnion("status", [
        z.object({ status: z.literal("passed"), attestedAt: z.string().datetime() }).strict(),
        z
          .object({
            status: z.literal("canary_blocked"),
            limitations: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      ])
    ),
  })
  .strict();

export type SandboxExecutionCapability =
  | {
      available: true;
      provider: ExecutionProvider;
      artifactGeneration: number;
      runtimeVersion: string;
      networkProfile: "package-install-v1";
    }
  | {
      available: false;
      provider: ExecutionProvider;
      reason:
        | "mode_disabled"
        | "provider_canary_blocked"
        | "attestation_missing"
        | "attestation_invalid"
        | "provider_attestation_missing";
    };

export function resolveSandboxExecutionCapability(input: {
  mode: string | undefined;
  provider: string | undefined;
  attestation: string | undefined;
  providerIsolation?: "enforced" | "canary_blocked";
}): SandboxExecutionCapability {
  const provider = providerSchema.catch("modal").parse(input.provider?.trim().toLowerCase());
  if (input.mode?.trim().toLowerCase() !== "enabled") {
    return { available: false, provider, reason: "mode_disabled" };
  }
  if ((input.providerIsolation ?? "canary_blocked") !== "enforced") {
    return { available: false, provider, reason: "provider_canary_blocked" };
  }
  if (!input.attestation?.trim()) {
    return { available: false, provider, reason: "attestation_missing" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(input.attestation);
  } catch {
    return { available: false, provider, reason: "attestation_invalid" };
  }
  const evidence = executionCanaryEvidenceSchema.safeParse(raw);
  if (!evidence.success) return { available: false, provider, reason: "attestation_invalid" };
  if (evidence.data.providers[provider]?.status !== "passed") {
    return { available: false, provider, reason: "provider_attestation_missing" };
  }
  return {
    available: true,
    provider,
    artifactGeneration: evidence.data.artifactGeneration,
    runtimeVersion: evidence.data.runtimeVersion,
    networkProfile: evidence.data.networkProfile,
  };
}
