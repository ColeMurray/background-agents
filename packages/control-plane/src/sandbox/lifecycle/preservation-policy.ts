import { parseRuntimeVersionNumber } from "../../image-builds/model";
import { MIN_PRESERVATION_RUNTIME_GENERATION } from "../runtime-manifest";

export type PreservationLifecyclePolicy = "confirmed" | "legacy";
export type PreservationLaunchSource = "new" | "existing";

export function supportsConfirmedPreservation(runtimeVersion: string | null): boolean {
  const generation = runtimeVersion === null ? null : parseRuntimeVersionNumber(runtimeVersion);
  return generation !== null && generation >= MIN_PRESERVATION_RUNTIME_GENERATION;
}

/** Existing state may retain its legacy lifecycle; new launches always fail closed. */
export function preservationPolicyForLaunch(
  source: PreservationLaunchSource,
  runtimeVersion: string | null
): PreservationLifecyclePolicy {
  if (source === "new") return "confirmed";
  return supportsConfirmedPreservation(runtimeVersion) ? "confirmed" : "legacy";
}
