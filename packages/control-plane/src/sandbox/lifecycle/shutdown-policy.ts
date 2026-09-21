import { parseRuntimeVersionNumber } from "../../image-builds/model";
import { MIN_SHUTDOWN_PROTOCOL_RUNTIME_GENERATION } from "../runtime-manifest";

export type ShutdownLifecyclePolicy = "confirmed" | "legacy";

export function supportsConfirmedShutdown(runtimeVersion: string | null): boolean {
  const generation = runtimeVersion === null ? null : parseRuntimeVersionNumber(runtimeVersion);
  return generation !== null && generation >= MIN_SHUTDOWN_PROTOCOL_RUNTIME_GENERATION;
}

/**
 * The policy a launch runs under, derived from the runtime version it boots.
 *
 * A restore or resume boots the binaries its snapshot captured, so its own
 * recorded version decides. A new launch boots either a prebuilt image, which
 * image selection has already held to this same floor, or the base image built
 * from the running deployment — so callers pass the deployed
 * `SANDBOX_RUNTIME_VERSION` rather than asserting a policy for it.
 *
 * Every caller therefore names the version it will actually run, and an unknown
 * or unparseable version fails closed to `legacy`: the ordered-shutdown
 * handshake is only claimed for a runtime known to implement it.
 */
export function shutdownPolicyForLaunch(runtimeVersion: string | null): ShutdownLifecyclePolicy {
  return supportsConfirmedShutdown(runtimeVersion) ? "confirmed" : "legacy";
}
