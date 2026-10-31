/** Whether this deployment's source-control provider can serve a route. */

import type { RequestContext } from "../http/request-context";
import { error } from "../http/responses";
import { createLogger } from "../logger";
import type { RouteAdmissionPolicy } from "../routes/shared";
import { resolveScmProviderFromEnv, SourceControlProviderError } from "../source-control";
import type { Env } from "../types";

const logger = createLogger("router");

/**
 * Refuse a route the configured SCM provider does not implement (501), or any route when the
 * provider configuration is invalid (500). Null when the route can be served.
 */
export function enforceImplementedScmProvider(
  policy: RouteAdmissionPolicy,
  path: string,
  env: Env,
  ctx: RequestContext
): Response | null {
  try {
    const provider = resolveScmProviderFromEnv(env.SCM_PROVIDER);
    if (
      policy.supportedScmProviders !== "all" &&
      !policy.supportedScmProviders.includes(provider)
    ) {
      logger.warn("SCM provider not implemented", {
        event: "scm.provider_not_implemented",
        scm_provider: provider,
        http_path: path,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return error(`SCM provider '${provider}' is not implemented in this deployment.`, 501);
    }

    return null;
  } catch (errorValue) {
    const errorMessage =
      errorValue instanceof SourceControlProviderError
        ? errorValue.message
        : "Invalid SCM provider configuration";

    logger.error("Invalid SCM provider configuration", {
      event: "scm.provider_invalid",
      error: errorValue instanceof Error ? errorValue : String(errorValue),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return error(errorMessage, 500);
  }
}
