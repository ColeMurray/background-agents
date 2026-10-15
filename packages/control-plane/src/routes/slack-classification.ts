import { Hono } from "hono";
import {
  OPENAI_SLACK_CLASSIFICATION_MODEL,
  SLACK_OAUTH_CLASSIFICATION_SERVER_TIMEOUT_MS,
  SLACK_CLASSIFICATION_TOOL,
  slackClassificationDecisionSchema,
  slackClassificationRequestSchema,
} from "@open-inspect/shared/slack-classification";
import { OpenAITokenBroker, OpenAITokenNotConfiguredError } from "../auth/openai-token-broker";
import { ModelProviderAccountBroker } from "../auth/model-provider-account-broker";
import { withinProviderAccessDeadline } from "../auth/provider-access-deadline";
import { modelProviderAccountAdapterRegistry } from "../auth/model-provider-account-default-adapters";
import { ProviderDefaultStore } from "../db/provider-account-defaults";
import { ModelProviderAccountStore } from "../db/model-provider-accounts";
import { ProviderCredentialStore } from "../db/provider-account-credentials";
import { D1ModelProviderAccountAtomicWriter } from "../db/model-provider-account-atomic-writer";
import { createLogger } from "../logger";
import { requestOpenAICodexFunction } from "../openai/codex-responses";
import { OpenAICodexUpstreamError } from "../openai/codex-errors";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import { error, json, serviceAuthorized, type RequestContext } from "./shared";

const logger = createLogger("slack-classification");

async function globalOpenAIToken(env: Env, ctx: RequestContext, deadlineAt: number) {
  const account = await new ProviderDefaultStore(ctx.db).get("openai");
  if (account) {
    if (account.unattendedMode !== "provider_account") {
      throw new OpenAITokenNotConfiguredError("Unattended subscription access is disabled");
    }
    const access = await new ModelProviderAccountBroker(
      {
        accounts: new ModelProviderAccountStore(ctx.db),
        credentials: new ProviderCredentialStore(ctx.db, env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY),
        atomicWriter: new D1ModelProviderAccountAtomicWriter(
          ctx.db,
          env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY
        ),
      },
      modelProviderAccountAdapterRegistry
    ).getAccess(account.providerAccountId, "openai", { deadlineAt });
    return { accessToken: access.accessToken, accountId: access.externalAccountId };
  }
  // Existing deployments can retain their global legacy OAuth grant until
  // they connect a provider account. A configured default never falls back.
  return new OpenAITokenBroker(
    ctx.db,
    env.REPO_SECRETS_ENCRYPTION_KEY || env.TOKEN_ENCRYPTION_KEY,
    logger
  ).refreshGlobal();
}

async function classify(
  request: Request,
  env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  if (env.SLACK_CLASSIFICATION_MODEL !== OPENAI_SLACK_CLASSIFICATION_MODEL || !env.EGRESS) {
    return error("Slack OAuth classification is not configured", 503);
  }
  const body = await parseBody(request, slackClassificationRequestSchema);
  if (body instanceof Response) return body;

  try {
    // Classification precedes target selection: never resolve repo, environment,
    // team, or user credentials here. Tokens stay inside the control plane.
    const deadlineAt = Date.now() + SLACK_OAUTH_CLASSIFICATION_SERVER_TIMEOUT_MS;
    const credentialOperation = globalOpenAIToken(env, ctx, deadlineAt);
    // Rotating grants must finish persistence or fencing after the caller stops waiting.
    ctx.executionCtx.submit(
      () =>
        credentialOperation.then(
          () => undefined,
          () => undefined
        ),
      { name: "slack-classification-credential-settlement" }
    );
    const token = await withinProviderAccessDeadline(credentialOperation, deadlineAt);
    const output = await requestOpenAICodexFunction(
      {
        accessToken: token.accessToken,
        accountId: token.accountId,
        requestId: ctx.request_id,
        traceId: ctx.trace_id,
        deadlineAt,
        model: OPENAI_SLACK_CLASSIFICATION_MODEL.slice("openai/".length),
        systemPrompt: "Select the best target by calling classify_target exactly once.",
        prompt: body.prompt,
        tool: {
          name: SLACK_CLASSIFICATION_TOOL.name,
          description: SLACK_CLASSIFICATION_TOOL.description,
          parameters: SLACK_CLASSIFICATION_TOOL.input_schema,
        },
      },
      env.EGRESS
    );
    // Project through the result schema; do not forward upstream envelopes,
    // headers, or unknown properties to Slack.
    return json(slackClassificationDecisionSchema.parse(output));
  } catch (caught) {
    // Upstream error payloads and exception causes can carry secrets. Keep both
    // logs and the Slack-facing response independent of those payloads.
    const missingCredential = caught instanceof OpenAITokenNotConfiguredError;
    logger.warn("Slack OAuth classification unavailable", {
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      missing_credential: missingCredential,
      upstream_status: caught instanceof OpenAICodexUpstreamError ? caught.status : undefined,
    });
    return error("Slack OAuth classification unavailable", missingCredential ? 503 : 502);
  }
}

export const slackClassificationRoutes = new Hono<ControlPlaneHonoEnv>();
slackClassificationRoutes.post(
  "/slack/target-classifications",
  admit({
    authentication: { kind: "service" },
    supportedScmProviders: "all",
    cacheControl: "private, no-store",
    authorization: serviceAuthorized("slack-bot"),
  }),
  (c) => dispatch(c, classify)
);
