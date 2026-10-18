import { SessionInternalPaths } from "../session/contracts";
import {
  piCapabilityAuthorityResponseSchema,
  type PiCapabilityAuthorityResponse,
} from "./capability-authority";

export const PI_EMERGENCY_POLICY_LOOKUP_TIMEOUT_MS = 1_000;

interface PiCapabilityAuthorityFetcher {
  fetch(request: Request): Promise<Response>;
}

/** Bounded SessionDO authority lookup, cancelled with the invoking tool when it stops. */
export async function fetchPiCapabilityAuthority(
  fetcher: PiCapabilityAuthorityFetcher,
  callerSignal?: AbortSignal
): Promise<PiCapabilityAuthorityResponse> {
  const timeout = new AbortController();
  const timeoutReason = new DOMException(
    "Pi capability authority lookup timed out",
    "TimeoutError"
  );
  const timeoutId = setTimeout(
    () => timeout.abort(timeoutReason),
    PI_EMERGENCY_POLICY_LOOKUP_TIMEOUT_MS
  );
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout.signal]) : timeout.signal;
  try {
    const response = await fetcher.fetch(
      new Request(`http://session${SessionInternalPaths.piCapabilityAuthority}`, { signal })
    );
    if (!response.ok) throw new Error(`Pi capability authority unavailable (${response.status})`);
    return piCapabilityAuthorityResponseSchema.parse(await response.json());
  } finally {
    clearTimeout(timeoutId);
  }
}
