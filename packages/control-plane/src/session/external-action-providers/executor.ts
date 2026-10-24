import type { JsonValue } from "@earendil-works/chord";
import type {
  ExternalActionExecutionResult,
  ExternalActionExecutor,
  ExternalActionProviderStatus,
} from "../external-action-gateway";
import {
  externalActionMarker,
  readExternalActionMarker,
  type ExternalActionProviderDefinition,
  type ProviderEndpoint,
} from "./definition";

/**
 * How a provider credential reaches its request.
 *
 * The credential is fetched per call, used for exactly one request, and
 * returned to nothing but the request headers. It never reaches a result, an
 * error message, a log line, or the agent.
 */
export interface ExternalActionCredentialResolver {
  resolve(): Promise<{ headers: Record<string, string> } | null>;
}

export interface ProviderFetchOptions {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signal: AbortSignal;
}

/** The subset of `fetch` a provider uses, so a test can inject faults. */
export type ProviderFetch = (url: string, init: ProviderFetchOptions) => Promise<Response>;

export interface ProviderExecutorOptions {
  readonly definition: ExternalActionProviderDefinition;
  readonly credentials: ExternalActionCredentialResolver;
  readonly fetch: ProviderFetch;
  readonly timeoutMs: number;
  readonly userAgent: string;
}

/** The provider said the effect can never exist. */
const NOT_ADMITTED_STATUSES = new Set([404]);
/** The provider refused this caller. The effect did not happen. */
const REJECTED_STATUSES = new Set([400, 401, 403, 422]);

/**
 * A provider executor that publishes one effect and can always say whether it
 * happened.
 *
 * The provider write is not transactional with the approval ledger, so a lost
 * response must never become a second publication. Every write carries a
 * marker derived from the action id, and reconciliation looks for that marker
 * before anything is written again.
 */
export function createProviderExecutor(options: ProviderExecutorOptions): ExternalActionExecutor {
  const { definition, credentials, fetch: perform, timeoutMs, userAgent } = options;

  const request = async (
    endpoint: ProviderEndpoint,
    signal?: AbortSignal
  ): Promise<{ status: number; body: unknown }> => {
    const credential = await credentials.resolve();
    if (!credential) {
      throw new ProviderCredentialUnavailableError(definition.provider);
    }
    // The provider must never be able to hold the request open. A hung
    // provider is an unknown outcome, so it becomes an indeterminate failure
    // that the gateway reconciles, never a request that never ends.
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort(new DOMException("Provider request timed out", "TimeoutError"));
    }, timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try {
      const response = await Promise.race([
        perform(endpoint.url, {
          method: endpoint.method,
          url: endpoint.url,
          headers: {
            ...credential.headers,
            accept: endpoint.accept ?? "application/json",
            "user-agent": userAgent,
            ...(endpoint.body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(endpoint.body === undefined ? {} : { body: endpoint.body }),
          signal: combined,
        }),
        rejectWhenAborted(combined),
      ]);
      const text = await response.text();
      let body: unknown = null;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      return { status: response.status, body };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async execute(action): Promise<ExternalActionExecutionResult> {
      const target = action.target;
      const args = action.arguments;
      const marker = externalActionMarker(action.id);
      const endpoint = definition.endpoint(target);
      const body = definition.composeBody(target, args, marker);
      let response: { status: number; body: unknown };
      try {
        response = await request({ ...endpoint, method: "POST", body }, undefined);
      } catch (error) {
        // A request that never completed may still have applied the effect, so
        // it is an unknown outcome, not a failure.
        if (isAbort(error)) {
          throw new ProviderIndeterminateError(
            definition.provider,
            "the request did not complete in time"
          );
        }
        throw error;
      }
      const { status, body: responseBody } = response;
      if (status >= 200 && status < 300) {
        return { kind: "succeeded", publicResult: definition.readResult(responseBody) };
      }
      if (REJECTED_STATUSES.has(status)) {
        return { kind: "rejected", error: `${definition.provider} refused the publication` };
      }
      if (NOT_ADMITTED_STATUSES.has(status)) {
        return { kind: "rejected", error: `${definition.provider} does not accept this target` };
      }
      // The provider failed in a way that may still have applied the effect.
      // The gateway treats this as indeterminate and reconciles by marker.
      throw new ProviderIndeterminateError(definition.provider, `status ${status}`);
    },

    async status(action): Promise<ExternalActionProviderStatus> {
      let response: { status: number; body: unknown };
      try {
        response = await request(definition.listPublished(action.target), undefined);
      } catch {
        return { kind: "unknown", reason: `${definition.provider} status is unavailable` };
      }
      const { status, body } = response;
      if (status === 404) return { kind: "not_admitted" };
      if (status < 200 || status >= 300) {
        return { kind: "unknown", reason: `${definition.provider} status is unavailable` };
      }
      const found = findPublished(definition, body, action.id);
      if (found) return { kind: "succeeded", publicResult: found };
      // The provider answered and the effect is not there. It was never applied.
      return { kind: "not_admitted" };
    },
  };
}

/** Whether the failure was the request being aborted. */
function isAbort(error: unknown): boolean {
  return (
    error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

/** The published effect this action left behind, if the provider kept it. */
function findPublished(
  definition: ExternalActionProviderDefinition,
  body: unknown,
  actionId: string
): JsonValue | null {
  const entries = definition.readPublished(body);
  for (const entry of entries) {
    const marker = definition.readMarker(entry);
    if (marker === actionId) return definition.readResult(entry);
  }
  return null;
}

/**
 * The provider's own list of published items.
 *
 * Providers answer with different shapes, so the reader accepts a list under
 * a few conventional keys and ignores anything it does not recognize.
 */
export function publishedEntries(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (typeof body !== "object" || body === null) return [];
  const record = body as Record<string, unknown>;
  for (const key of ["items", "comments", "messages", "replies", "results", "data"]) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

/** The provider has no usable credential right now. */
export class ProviderCredentialUnavailableError extends Error {
  constructor(provider: string) {
    super(`${provider} has no credential available for this publication`);
    this.name = "ProviderCredentialUnavailableError";
  }
}

/** The provider failed in a way that may still have applied the effect. */
export class ProviderIndeterminateError extends Error {
  constructor(
    provider: string,
    readonly reason: string
  ) {
    super(`${provider} did not confirm the publication (${reason})`);
    this.name = "ProviderIndeterminateError";
  }
}

/** Reject as soon as the request is aborted, even if the provider ignores it. */
function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(abortReason(signal)), { once: true });
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The provider request was aborted", "AbortError");
}

export { readExternalActionMarker };
