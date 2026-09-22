import { z } from "zod";
import type { SessionModelProviderAuth } from "@open-inspect/shared/types/provider-accounts";
import type { Env } from "../types";
import type { SandboxRouteContext } from "../routes/shared";
import { createSessionRuntimeClient } from "../session/runtime-client";
import { SessionInternalPaths } from "../session/contracts";

const generationSchema = z.object({
  sandboxId: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
});
export class StaleProviderBindingError extends Error {
  constructor() {
    super("stale_provider_binding");
  }
}

/** Re-authenticate the runtime at both ends of credential acquisition. Headers confer no authority. */
export async function captureIssuanceGeneration(
  request: Request,
  env: Env,
  ctx: SandboxRouteContext,
  binding: SessionModelProviderAuth,
  checkRevision = true
) {
  const revision = binding.bindingRevision ?? 1;
  const expected = request.headers.get("x-provider-binding-revision");
  if (
    checkRevision &&
    ((expected !== null && expected !== String(revision)) || (revision > 1 && expected === null))
  )
    throw new StaleProviderBindingError();
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) throw new StaleProviderBindingError();
  const response = await createSessionRuntimeClient(env, ctx).fetch(
    ctx.principal.sessionId,
    SessionInternalPaths.verifySandboxToken,
    {
      method: "POST",
      body: JSON.stringify({ token: authorization.slice(7) }),
      headers: { "content-type": "application/json" },
    }
  );
  if (!response.ok) throw new StaleProviderBindingError();
  const generation = generationSchema.safeParse(await response.json());
  if (!generation.success || generation.data.sandboxId !== ctx.principal.sandboxId)
    throw new StaleProviderBindingError();
  return generation.data;
}

export async function verifyIssuanceFence(
  request: Request,
  env: Env,
  ctx: SandboxRouteContext,
  binding: Extract<SessionModelProviderAuth, { authMode: "provider_account" }>,
  generation: z.infer<typeof generationSchema>,
  credentialVersion: number
) {
  const current = await captureIssuanceGeneration(request, env, ctx, binding);
  if (current.sandboxId !== generation.sandboxId || current.createdAt !== generation.createdAt)
    throw new StaleProviderBindingError();
  // One final SQL snapshot checks binding, lifecycle, and credential version after all external awaits.
  const valid = await ctx.db
    .prepare(
      `SELECT 1 AS valid FROM session_model_provider_auth b
    JOIN model_provider_accounts a ON a.id = b.provider_account_id AND a.provider = b.provider
    JOIN model_provider_account_credentials c ON c.provider_account_id = a.id
    JOIN sessions s ON s.id = b.session_id
    WHERE b.session_id = ? AND b.provider = ? AND b.provider_account_id = ? AND b.binding_revision = ?
      AND a.status = 'active' AND a.archived_at IS NULL AND s.status NOT IN ('archived', 'cancelled')
      AND c.credential_version = ?`
    )
    .bind(
      ctx.principal.sessionId,
      binding.provider,
      binding.providerAccountId,
      binding.bindingRevision ?? 1,
      credentialVersion
    )
    .first();
  if (!valid) throw new StaleProviderBindingError();
}
