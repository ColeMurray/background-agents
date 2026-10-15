import { Hono } from "hono";
import { MODEL_PROVIDER_ACCOUNT_ID_PATTERN } from "@open-inspect/shared/types/provider-accounts";
import { ModelProviderAccountBroker } from "../auth/model-provider-account-broker";
import { modelProviderAccountAdapterRegistry } from "../auth/model-provider-account-default-adapters";
import { D1ModelProviderAccountAtomicWriter } from "../db/model-provider-account-atomic-writer";
import { ModelProviderAccountStore } from "../db/model-provider-accounts";
import { ProviderCredentialStore } from "../db/provider-account-credentials";
import { ProviderAccountUsageService } from "../model-provider-accounts/usage-service";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { error, json, SCM_AGNOSTIC_HUMAN_USER_ROUTE, requirePermission } from "./shared";

export const providerAccountUsageRoutes = new Hono<ControlPlaneHonoEnv>();
providerAccountUsageRoutes.get(
  "/model-provider-accounts/:id/usage",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    cacheControl: "private, no-store",
    authorization: requirePermission("provider_accounts.read"),
  }),
  (c) =>
    dispatch(c, async (_request, env, params, ctx) => {
      if (!MODEL_PROVIDER_ACCOUNT_ID_PATTERN.test(params.id))
        return error("Provider account not found", 404);
      const accounts = new ModelProviderAccountStore(ctx.db);
      const snapshot = await accounts.getLifecycleSnapshot(params.id);
      if (!snapshot || snapshot.account.archivedAt !== null)
        return error("Provider account not found", 404);
      const { account, lifecycleVersion } = snapshot;
      const broker = new ModelProviderAccountBroker(
        {
          accounts,
          credentials: new ProviderCredentialStore(ctx.db, env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY),
          atomicWriter: new D1ModelProviderAccountAtomicWriter(
            ctx.db,
            env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY
          ),
        },
        modelProviderAccountAdapterRegistry
      );
      const service = new ProviderAccountUsageService(
        broker,
        env.REPOS_CACHE,
        env.EGRESS ?? { fetch: (input, init) => fetch(input, init) },
        ctx.executionCtx
      );
      return json({ usage: await service.read(account, lifecycleVersion) });
    })
);
