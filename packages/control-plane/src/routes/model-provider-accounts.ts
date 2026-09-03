import {
  MODEL_PROVIDER_ACCOUNT_ID_PATTERN,
  PROVIDER_DEVICE_AUTHORIZATION_ID_PATTERN,
  connectModelProviderAccountRequestSchema,
  modelProviderAccountDisplayNameSchema,
  modelProviderAccountDefaultRequestSchema,
  modelProviderAccountStatusSchema,
  reconnectModelProviderAccountRequestSchema,
  startProviderDeviceAuthorizationRequestSchema,
  subscriptionProviderIdSchema,
  type SubscriptionProviderId,
} from "@open-inspect/shared/types/provider-accounts";
import { Hono } from "hono";
import { z } from "zod";
import { createLogger } from "../logger";
import { generateId } from "../auth/crypto";
import { modelProviderAccountAdapterRegistry } from "../auth/model-provider-account-default-adapters";
import {
  ModelProviderAccountBroker,
  ModelProviderAccountBrokerError,
} from "../auth/model-provider-account-broker";
import { ModelProviderAccountStore } from "../db/model-provider-accounts";
import { D1ModelProviderAccountAtomicWriter } from "../db/model-provider-account-atomic-writer";
import { ProviderCredentialStore } from "../db/provider-account-credentials";
import { ProviderAccountAuthorizationStore } from "../db/provider-account-authorizations";
import {
  ProviderDefaultConstraintError,
  ProviderDefaultStore,
} from "../db/provider-account-defaults";
import { SessionIndexStore } from "../db/session-index";
import { listLegacyProviderCredentials } from "../model-provider-accounts/legacy-provider-credentials";
import {
  ModelProviderAccountService,
  ProviderAccountServiceError,
} from "../model-provider-accounts/service";
import {
  ProviderDeviceAuthorizationError,
  ProviderDeviceAuthorizationService,
} from "../model-provider-accounts/device-authorization-service";
import { ProviderDeviceAuthorizationFinalizer } from "../model-provider-accounts/device-authorization-finalizer";
import {
  ProviderAccountSelectionPolicy,
  ProviderAccountSelectionPolicyError,
} from "../model-provider-accounts/selection-policy";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { SessionInternalPaths } from "../session/contracts";
import { createSessionRuntimeClient } from "../session/runtime-client";
import {
  error,
  json,
  parseJsonBody,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  type RequestContext,
  type SandboxRouteContext,
  NO_AUTHORIZATION,
  requirePermission,
} from "./shared";

const PRIVATE_NO_STORE = "private, no-store" as const;
const NO_STORE = "no-store" as const;
const renameSchema = z.strictObject({ displayName: modelProviderAccountDisplayNameSchema });
const logger = createLogger("router:model-provider-accounts");
const legacyAccessSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().optional(),
  account_id: z.string().optional(),
});
const LEGACY_REFRESH_PATH = {
  openai: SessionInternalPaths.openaiTokenRefresh,
  xai: SessionInternalPaths.xaiTokenRefresh,
} as const;
const providerAuthorizationLogger = createLogger("provider-device-authorization");

function service(env: Env, ctx: RequestContext): ModelProviderAccountService {
  const accounts = new ModelProviderAccountStore(ctx.db);
  const credentials = new ProviderCredentialStore(ctx.db, env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY);
  return new ModelProviderAccountService(
    accounts,
    credentials,
    new D1ModelProviderAccountAtomicWriter(ctx.db, env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY),
    modelProviderAccountAdapterRegistry,
    { generateId: () => generateId(), now: () => Date.now() }
  );
}

function authorizationService(env: Env, ctx: RequestContext): ProviderDeviceAuthorizationService {
  const accounts = new ModelProviderAccountStore(ctx.db);
  const finalizer = new ProviderDeviceAuthorizationFinalizer(
    accounts,
    new D1ModelProviderAccountAtomicWriter(ctx.db, env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY),
    () => generateId(16)
  );
  return new ProviderDeviceAuthorizationService(
    new ProviderAccountAuthorizationStore(ctx.db),
    accounts,
    finalizer,
    env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY,
    modelProviderAccountAdapterRegistry,
    { generateId, now: () => Date.now() },
    providerAuthorizationLogger
  );
}

function provider(value: string): SubscriptionProviderId | Response {
  const parsed = subscriptionProviderIdSchema.safeParse(value);
  return parsed.success ? parsed.data : error("Unsupported model provider", 400);
}

function accountId(id: string): string | Response {
  return MODEL_PROVIDER_ACCOUNT_ID_PATTERN.test(id)
    ? id
    : error("Invalid provider account ID", 400);
}

async function accountOperation(
  ctx: RequestContext,
  operation: () => Promise<Response>
): Promise<Response> {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof ProviderAccountServiceError) return error(cause.message, cause.status);
    const message = cause instanceof Error ? cause.message : "Provider account operation failed";
    logger.error("provider_account.operation_failed", {
      event: "provider_account.operation_failed",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      error: cause instanceof Error ? cause : String(cause),
    });
    if (/UNIQUE constraint/i.test(message)) {
      return error("Provider account conflicts with an existing account", 409);
    }
    if (/default account/i.test(message)) {
      return error("A default provider account cannot be changed", 409);
    }
    return error("Provider account operation failed", 502);
  }
}

async function authorizationOperation(
  ctx: RequestContext,
  operation: () => Promise<Response>
): Promise<Response> {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof ProviderDeviceAuthorizationError) {
      return json({ error: cause.message, retryable: cause.retryable }, cause.status);
    }
    providerAuthorizationLogger.error("provider_device_authorization.operation_failed", {
      event: "provider_device_authorization.operation_failed",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      error: cause instanceof Error ? cause : String(cause),
    });
    return error("Provider authorization failed", 502);
  }
}

function authorizationId(id: string): string | Response {
  return PROVIDER_DEVICE_AUTHORIZATION_ID_PATTERN.test(id)
    ? id
    : error("Authorization transaction not found", 404);
}

const ACCOUNTS_READ = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  cacheControl: PRIVATE_NO_STORE,
  authorization: requirePermission("provider_accounts.read"),
});
const ACCOUNTS_MANAGE = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  cacheControl: PRIVATE_NO_STORE,
  authorization: requirePermission("provider_accounts.manage"),
});

export const modelProviderAccountRoutes = new Hono<ControlPlaneHonoEnv>();

modelProviderAccountRoutes.get("/model-provider-accounts/legacy-credentials", ACCOUNTS_READ, (c) =>
  dispatch(c, async (_request, _env, _params, ctx) =>
    json({ legacyKeys: await listLegacyProviderCredentials(ctx.db) })
  )
);
modelProviderAccountRoutes.get("/model-provider-accounts", ACCOUNTS_READ, (c) =>
  dispatch(c, async (request, env, _params, ctx) => {
    const accounts = service(env, ctx);
    const url = new URL(request.url);
    const providerFilter = url.searchParams.get("provider");
    let parsedProvider: SubscriptionProviderId | undefined;
    if (providerFilter) {
      const result = provider(providerFilter);
      if (result instanceof Response) return result;
      parsedProvider = result;
    }
    const includeArchived = url.searchParams.get("archived") === "true";
    const status = url.searchParams.get("status");
    if (status !== null && !modelProviderAccountStatusSchema.safeParse(status).success) {
      return error("Unsupported provider account status", 400);
    }
    const listed = await accounts.list(parsedProvider, includeArchived);
    return json({
      accounts: status ? listed.filter((account) => account.status === status) : listed,
    });
  })
);
modelProviderAccountRoutes.post("/model-provider-accounts", ACCOUNTS_MANAGE, (c) =>
  dispatch(c, async (request, env, _params, ctx) => {
    const body = await parseJsonBody<unknown>(request);
    if (body instanceof Response) return body;
    const parsed = connectModelProviderAccountRequestSchema.safeParse(body);
    if (!parsed.success) return error("Invalid provider account", 400);
    const accounts = service(env, ctx);
    return accountOperation(ctx, async () => {
      const result = await accounts.create(parsed.data, ctx.principal.userId);
      return json(result, result.reconnectedExisting ? 200 : 201);
    });
  })
);
modelProviderAccountRoutes.post(
  "/model-provider-accounts/:provider/device-authorizations",
  ACCOUNTS_MANAGE,
  (c) =>
    dispatch(c, async (request, env, params, ctx) => {
      const parsedProvider = provider(params.provider);
      if (parsedProvider instanceof Response) return parsedProvider;
      const body = await parseJsonBody<unknown>(request);
      if (body instanceof Response) return body;
      const parsed = startProviderDeviceAuthorizationRequestSchema.safeParse(body);
      if (!parsed.success) return error("Invalid device authorization request", 400);
      return authorizationOperation(ctx, async () =>
        json(
          await authorizationService(env, ctx).start(
            ctx.principal.userId,
            parsedProvider,
            parsed.data
          ),
          201
        )
      );
    })
);
modelProviderAccountRoutes.post(
  "/model-provider-accounts/:provider/device-authorizations/:id/poll",
  ACCOUNTS_MANAGE,
  (c) =>
    dispatch(c, async (_request, env, params, ctx) => {
      const parsedProvider = provider(params.provider);
      if (parsedProvider instanceof Response) return parsedProvider;
      const id = authorizationId(params.id);
      if (id instanceof Response) return id;
      return authorizationOperation(ctx, async () =>
        json(await authorizationService(env, ctx).poll(ctx.principal.userId, parsedProvider, id))
      );
    })
);
modelProviderAccountRoutes.delete(
  "/model-provider-accounts/:provider/device-authorizations/:id",
  ACCOUNTS_MANAGE,
  (c) =>
    dispatch(c, async (_request, env, params, ctx) => {
      const parsedProvider = provider(params.provider);
      if (parsedProvider instanceof Response) return parsedProvider;
      const id = authorizationId(params.id);
      if (id instanceof Response) return id;
      return authorizationOperation(ctx, async () => {
        await authorizationService(env, ctx).cancel(ctx.principal.userId, parsedProvider, id);
        return new Response(null, { status: 204 });
      });
    })
);
modelProviderAccountRoutes.get("/model-provider-accounts/:id", ACCOUNTS_READ, (c) =>
  dispatch(c, async (_request, env, params, ctx) => {
    const id = accountId(params.id);
    if (id instanceof Response) return id;
    const accounts = service(env, ctx);
    return accountOperation(ctx, async () => json({ account: await accounts.get(id) }));
  })
);
modelProviderAccountRoutes.patch("/model-provider-accounts/:id", ACCOUNTS_MANAGE, (c) =>
  dispatch(c, async (request, env, params, ctx) => {
    const id = accountId(params.id);
    if (id instanceof Response) return id;
    const body = await parseJsonBody<unknown>(request);
    if (body instanceof Response) return body;
    const parsed = renameSchema.safeParse(body);
    if (!parsed.success) return error("Invalid provider account name", 400);
    const accounts = service(env, ctx);
    return accountOperation(ctx, async () =>
      json({ account: await accounts.rename(id, parsed.data.displayName, ctx.principal.userId) })
    );
  })
);
for (const action of ["verify", "disable", "enable"] as const) {
  modelProviderAccountRoutes.post(`/model-provider-accounts/:id/${action}`, ACCOUNTS_MANAGE, (c) =>
    dispatch(c, async (_request, env, params, ctx) => {
      const id = accountId(params.id);
      if (id instanceof Response) return id;
      const accounts = service(env, ctx);
      return accountOperation(ctx, async () => {
        const account =
          action === "verify"
            ? await accounts.verify(id, ctx.principal.userId)
            : await accounts.setStatus(
                id,
                action === "enable" ? "active" : "disabled",
                ctx.principal.userId
              );
        return json({ account });
      });
    })
  );
}
modelProviderAccountRoutes.post("/model-provider-accounts/:id/reconnect", ACCOUNTS_MANAGE, (c) =>
  dispatch(c, async (request, env, params, ctx) => {
    const id = accountId(params.id);
    if (id instanceof Response) return id;
    const body = await parseJsonBody<unknown>(request);
    if (body instanceof Response) return body;
    const parsed = reconnectModelProviderAccountRequestSchema.safeParse(body);
    if (!parsed.success) return error("Invalid provider account reconnect request", 400);
    const accounts = service(env, ctx);
    return accountOperation(ctx, async () =>
      json({ account: await accounts.reconnect(id, parsed.data, ctx.principal.userId) })
    );
  })
);
modelProviderAccountRoutes.delete("/model-provider-accounts/:id", ACCOUNTS_MANAGE, (c) =>
  dispatch(c, async (_request, env, params, ctx) => {
    const id = accountId(params.id);
    if (id instanceof Response) return id;
    const accounts = service(env, ctx);
    return accountOperation(ctx, async () => {
      await accounts.archive(id, ctx.principal.userId);
      return new Response(null, { status: 204 });
    });
  })
);
modelProviderAccountRoutes.get("/model-provider-account-defaults", ACCOUNTS_READ, (c) =>
  dispatch(c, async (_request, _env, _params, ctx) =>
    json({ defaults: await new ProviderDefaultStore(ctx.db).list() })
  )
);
modelProviderAccountRoutes.put("/model-provider-account-defaults/:provider", ACCOUNTS_MANAGE, (c) =>
  dispatch(c, async (request, _env, params, ctx) => {
    const parsedProvider = provider(params.provider);
    if (parsedProvider instanceof Response) return parsedProvider;
    const body = await parseJsonBody<unknown>(request);
    if (body instanceof Response) return body;
    const parsed = modelProviderAccountDefaultRequestSchema.safeParse(body);
    if (!parsed.success) return error("Invalid provider default", 400);
    const defaults = new ProviderDefaultStore(ctx.db);
    try {
      await new ProviderAccountSelectionPolicy(
        new ModelProviderAccountStore(ctx.db),
        modelProviderAccountAdapterRegistry
      ).validateDefault(parsedProvider, parsed.data.providerAccountId);
      await defaults.set(
        parsedProvider,
        parsed.data.providerAccountId,
        parsed.data.unattendedMode,
        ctx.principal.userId
      );
      return json({ default: await defaults.get(parsedProvider) });
    } catch (cause) {
      if (cause instanceof ProviderAccountSelectionPolicyError) {
        return error(cause.message, cause.status);
      }
      if (cause instanceof ProviderDefaultConstraintError) {
        return error(cause.message, 409);
      }
      logger.error("provider_account.default_update_failed", {
        event: "provider_account.default_update_failed",
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
        error: cause instanceof Error ? cause : String(cause),
      });
      return error("Provider default could not be updated", 502);
    }
  })
);
modelProviderAccountRoutes.delete(
  "/model-provider-account-defaults/:provider",
  ACCOUNTS_MANAGE,
  (c) =>
    dispatch(c, async (_request, _env, params, ctx) => {
      const parsedProvider = provider(params.provider);
      if (parsedProvider instanceof Response) return parsedProvider;
      await new ProviderDefaultStore(ctx.db).remove(parsedProvider);
      return new Response(null, { status: 204 });
    })
);

async function handleLegacyProviderAccess(
  env: Env,
  ctx: SandboxRouteContext,
  sessionId: string,
  providerId: SubscriptionProviderId
): Promise<Response> {
  const response = await createSessionRuntimeClient(env, ctx).fetch(
    sessionId,
    LEGACY_REFRESH_PATH[providerId],
    { method: "POST" }
  );
  if (!response.ok) return response;
  const parsed = legacyAccessSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return error("Provider access unavailable", 503);
  return json({
    accessToken: parsed.data.access_token,
    ...(parsed.data.expires_in === undefined ? {} : { expiresIn: parsed.data.expires_in }),
    providerMetadata:
      providerId === "openai" && parsed.data.account_id
        ? { accountId: parsed.data.account_id }
        : {},
  });
}

async function handleProviderAccess(
  _request: Request,
  env: Env,
  params: { id: string; provider: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  const sessionId = params.id;
  const parsedProvider = provider(params.provider);
  if (parsedProvider instanceof Response) return parsedProvider;
  let binding;
  try {
    binding = await new SessionIndexStore(ctx.db).getProviderAuthForProvider(
      sessionId,
      parsedProvider
    );
  } catch (cause) {
    logger.error("provider_account.session_binding_lookup_failed", {
      event: "provider_account.session_binding_lookup_failed",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      session_id: sessionId,
      provider: parsedProvider,
      error: cause instanceof Error ? cause : String(cause),
    });
    return error("Session provider auth unavailable", 503);
  }
  if (!binding) return error("Session provider account is not configured", 404);
  if (binding.authMode === "legacy_scoped_oauth") {
    return handleLegacyProviderAccess(env, ctx, sessionId, parsedProvider);
  }
  if (binding.authMode === "api_key") {
    return error("Session uses API-key mode for this provider", 409);
  }
  const broker = new ModelProviderAccountBroker(
    {
      accounts: new ModelProviderAccountStore(ctx.db),
      credentials: new ProviderCredentialStore(ctx.db, env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY),
      atomicWriter: new D1ModelProviderAccountAtomicWriter(
        ctx.db,
        env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY
      ),
    },
    modelProviderAccountAdapterRegistry,
    { now: () => Date.now(), createOwner: () => generateId() }
  );
  try {
    return json(await broker.getAccess(binding.providerAccountId, parsedProvider));
  } catch (cause) {
    if (cause instanceof ModelProviderAccountBrokerError) {
      const status =
        cause.code === "account_not_found" ? 404 : cause.code === "upstream_retry_safe" ? 502 : 409;
      return error(cause.message, status);
    }
    return error("Provider access unavailable", 503);
  }
}

modelProviderAccountRoutes.post(
  "/sessions/:id/provider-auth/:provider/access-token",
  admit({ ...SCM_AGNOSTIC_SANDBOX_ROUTE, cacheControl: NO_STORE, authorization: NO_AUTHORIZATION }),
  (c) => dispatch(c, handleProviderAccess)
);
