import { z } from "zod";
import { featureCapabilityModeSchema } from "@open-inspect/shared/capability-modes";
import { SessionInternalPaths } from "../session/contracts";

/**
 * The execution principal: the authority a harness acts under.
 *
 * A harness that runs inside a sandbox is contained by the sandbox. A harness
 * that runs in a Durable Object is not, so it needs something the sandbox gave
 * for free: an in-process, session-scoped authority, decided by the session
 * from the current database, and presented to the harness as a capability
 * object.
 *
 * This is that object. It is **not** a sandbox principal and **not** a
 * service principal: it names no user, carries no credential, and grants
 * nothing by itself. It is what the owning session says the harness may do
 * right now, and the session is the only thing that may change it.
 */
export const executionPrincipalResponseSchema = z
  .object({
    /** The capabilities the session was created with, or null before it was. */
    snapshot: z.record(z.string(), featureCapabilityModeSchema).nullable(),
    /** The capabilities the deployment permits now. */
    current: z.record(z.string(), featureCapabilityModeSchema),
  })
  .strict();

export type ExecutionPrincipalResponse = z.infer<typeof executionPrincipalResponseSchema>;

export const EMERGENCY_POLICY_LOOKUP_TIMEOUT_MS = 1_000;

interface ExecutionPrincipalFetcher {
  fetch(request: Request): Promise<Response>;
}

/** Bounded SessionDO authority lookup, cancelled with the invoking tool when it stops. */
export async function fetchExecutionPrincipal(
  fetcher: ExecutionPrincipalFetcher,
  callerSignal?: AbortSignal
): Promise<ExecutionPrincipalResponse> {
  const timeout = new AbortController();
  const timeoutReason = new DOMException(
    "The execution principal lookup timed out",
    "TimeoutError"
  );
  const timeoutId = setTimeout(
    () => timeout.abort(timeoutReason),
    EMERGENCY_POLICY_LOOKUP_TIMEOUT_MS
  );
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout.signal]) : timeout.signal;
  try {
    const response = await fetcher.fetch(
      new Request(`http://session${SessionInternalPaths.piCapabilityAuthority}`, { signal })
    );
    if (!response.ok)
      throw new Error(`The execution principal is unavailable (${response.status})`);
    return executionPrincipalResponseSchema.parse(await response.json());
  } finally {
    clearTimeout(timeoutId);
  }
}
