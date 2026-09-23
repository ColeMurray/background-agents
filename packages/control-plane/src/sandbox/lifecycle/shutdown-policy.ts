import { parseRuntimeVersionNumber } from "../../image-builds/model";
import { MIN_SHUTDOWN_PROTOCOL_RUNTIME_GENERATION } from "../runtime-manifest";

export type ShutdownLifecyclePolicy = "confirmed" | "legacy";
export type ShutdownLaunchSource = "new" | "existing";

export function supportsConfirmedShutdown(runtimeVersion: string | null): boolean {
  const generation = runtimeVersion === null ? null : parseRuntimeVersionNumber(runtimeVersion);
  return generation !== null && generation >= MIN_SHUTDOWN_PROTOCOL_RUNTIME_GENERATION;
}

/** Existing state may retain its legacy lifecycle; new launches always fail closed. */
export function shutdownPolicyForLaunch(
  source: ShutdownLaunchSource,
  runtimeVersion: string | null
): ShutdownLifecyclePolicy {
  if (source === "new") return "confirmed";
  return supportsConfirmedShutdown(runtimeVersion) ? "confirmed" : "legacy";
}
