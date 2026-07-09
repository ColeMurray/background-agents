/**
 * Environment save-hooks (design §7.3/§7.4).
 *
 * Saving an environment triggers an immediate prebuild instead of waiting for
 * the cron, and a secret change additionally invalidates every live image
 * before the new build starts — spawn matching sees repositories through the
 * fingerprint but cannot see secrets, so without write-side invalidation a
 * failed or in-flight rebuild would leave revoked values baked in a
 * still-selectable image.
 */

import { EnvironmentImageStore } from "../db/environment-images";
import { createLogger } from "../logger";
import { resolveRepoImageProvider } from "../repo-images/provider-policy";
import type { Env } from "../types";
import type { RequestContext } from "../routes/shared";
import { createEnvironmentImageBuildWorkflowFromEnv } from "./workflow";

const logger = createLogger("environment-images:save-hooks");

/**
 * Kick a prebuild after an environment (or its secrets) changed. Best-effort
 * and detached — a build-trigger failure must never fail the CRUD operation
 * that invoked it. No-op on providers without image support; callers gate on
 * the environment's prebuild_enabled flag (they already hold the row).
 */
export function scheduleEnvironmentImageBuildOnSave(
  env: Env,
  environmentId: string,
  ctx: RequestContext
): void {
  if (!resolveRepoImageProvider(env.SANDBOX_PROVIDER)) return;

  const task = createEnvironmentImageBuildWorkflowFromEnv(env)
    .triggerBuildIfStale(environmentId, { request_id: ctx.request_id, trace_id: ctx.trace_id })
    .then((result) => {
      logger.info("environment_image.save_hook_trigger", {
        environment_id: environmentId,
        result: result.type,
        build_id: result.type === "up_to_date" ? null : result.buildId,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
    })
    .catch((e) => {
      logger.warn("environment_image.save_hook_trigger_failed", {
        environment_id: environmentId,
        error: e instanceof Error ? e.message : String(e),
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
    });

  if (ctx.executionCtx) {
    ctx.executionCtx.waitUntil(task);
  }
}

/**
 * Secret-change invalidation. Synchronous, called right after a successful
 * secret mutation and BEFORE the response: a failure here must surface as an
 * error so the caller knows revoked values may still be baked in a selectable
 * image and retries. Sessions in the rebuild window boot from base — never
 * blocked, never stale.
 */
export async function supersedeEnvironmentImagesForSecretsChange(
  env: Env,
  environmentId: string,
  ctx: RequestContext
): Promise<void> {
  const superseded = await new EnvironmentImageStore(env.DB).supersedeActiveImages(environmentId);
  if (superseded > 0) {
    logger.info("environment_image.secrets_change_superseded", {
      environment_id: environmentId,
      superseded,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
  }
}
