/**
 * Image-build save-hooks.
 *
 * Saving a build scope's owning entity triggers an immediate prebuild instead
 * of waiting for the cron, and a secret change additionally invalidates every
 * live image before the new build starts — spawn matching sees repositories
 * through the fingerprint but cannot see secrets, so without write-side
 * invalidation a failed or in-flight rebuild would leave revoked values baked
 * in a still-selectable image.
 */

import { ImageBuildStore } from "../db/image-builds";
import { createLogger } from "../logger";
import type { RequestContext } from "../routes/shared";
import type { Env } from "../types";
import type { ImageBuildScope } from "./model";
import { resolveImageBuildProvider } from "./provider-policy";
import { createImageBuildWorkflowFromEnv } from "./workflow";

const logger = createLogger("image-builds:save-hooks");

/**
 * Kick a prebuild after a scope's entity (or its secrets) changed.
 * Best-effort and detached — a build-trigger failure must never fail the CRUD
 * operation that invoked it. No-op on providers without image support;
 * callers gate on the entity's prebuild flag (they already hold the row).
 */
export function scheduleImageBuildOnSave(
  env: Env,
  scope: ImageBuildScope,
  ctx: RequestContext
): void {
  if (!resolveImageBuildProvider(env.SANDBOX_PROVIDER)) return;

  const task = createImageBuildWorkflowFromEnv(env)
    .triggerBuildIfStale(scope, { request_id: ctx.request_id, trace_id: ctx.trace_id })
    .then((result) => {
      logger.info("image_build.save_hook_trigger", {
        scope_kind: scope.kind,
        scope_id: scope.id,
        result: result.type,
        build_id: result.type === "up_to_date" ? null : result.buildId,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
    })
    .catch((e) => {
      logger.warn("image_build.save_hook_trigger_failed", {
        scope_kind: scope.kind,
        scope_id: scope.id,
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
export async function supersedeImageBuildsForSecretsChange(
  env: Env,
  scope: ImageBuildScope,
  ctx: RequestContext
): Promise<void> {
  const superseded = await new ImageBuildStore(env.DB).supersedeActiveImages(scope);
  if (superseded > 0) {
    logger.info("image_build.secrets_change_superseded", {
      scope_kind: scope.kind,
      scope_id: scope.id,
      superseded,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
  }
}
