/**
 * Shared plumbing for the Slack and Linear bots' target classifiers.
 *
 * Both bots resolve one request target from the model id alone and, on the
 * OpenAI path, speak the same strict structured-output dialect of the Chat
 * Completions API. Only that target resolution and the OpenAI transport live
 * here; each bot keeps its own response validation, prompt, and Messages API
 * transport, which serves both Anthropic and Claude in Amazon Bedrock.
 */

import { z } from "zod";

/**
 * Model the classifiers use when a deployment sets no override.
 */
export const DEFAULT_CLASSIFICATION_MODEL = "claude-haiku-4-5";

/**
 * Bound on a single classification request to any provider, so a stalled
 * model call can't hang message handling indefinitely.
 */
export const CLASSIFICATION_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Cap on an OpenAI classification response.
 *
 * Four times the Anthropic tool-call budget because gpt-5-family reasoning
 * tokens are billed inside `max_completion_tokens`: a tighter cap can be spent
 * on reasoning before the structured JSON is emitted, truncating the response.
 */
export const OPENAI_CLASSIFICATION_MAX_COMPLETION_TOKENS = 2000;

/**
 * A classification model id parsed into the provider that serves it and the
 * model id sent to that provider, plus the AWS Region for Bedrock.
 */
export type ClassificationModel =
  | { provider: "anthropic"; model: string }
  | { provider: "openai"; model: string }
  | { provider: "bedrock"; region: string; model: string };

/**
 * Worker bindings a classifier reads: the model id and each provider's key.
 * A deployment binds only the key its model's provider needs.
 */
export interface ClassificationEnv {
  CLASSIFICATION_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  BEDROCK_API_KEY?: string;
}

/**
 * A Messages API endpoint: the Anthropic API or Claude in Amazon Bedrock.
 *
 * `baseUrl` has no `/v1`: callers append `/v1/messages`, or pass it to the
 * Anthropic SDK as `baseURL`.
 */
export interface AnthropicMessagesTarget {
  protocol: "anthropic-messages";
  provider: "anthropic" | "bedrock";
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * The OpenAI Chat Completions endpoint, called through
 * {@link callOpenAIStructured}.
 */
export interface OpenAIChatTarget {
  protocol: "openai-chat";
  provider: "openai";
  apiKey: string;
  model: string;
}

/**
 * The endpoint, credential, and model that serve a classification request.
 * Callers dispatch on `protocol`; `provider` names the service for logs.
 */
export type ClassificationTarget = AnthropicMessagesTarget | OpenAIChatTarget;

type ClassificationProvider = ClassificationModel["provider"];

// Mirrors local.classifier_model_patterns in
// terraform/environments/production/locals.tf, so plan rejects the ids the
// bots reject. The Bedrock pattern checks format only: Bedrock can still
// reject a matching id, such as an in-Region model id that serves on-demand
// traffic only through an inference profile.
const MODEL_ID_PATTERNS = {
  anthropic: /^(?:anthropic\/(?<model>\s*\S.*)|claude-\s*\S.*)$/,
  openai: /^(?:openai\/(?<model>\s*\S.*)|gpt-\s*\S.*)$/,
  bedrock:
    /^bedrock\/(?<region>[a-z]{2}(?:-[a-z]+)+-[0-9]+)\/(?<model>(?:[a-z]+(?:-[a-z]+)?\.)?anthropic\.claude-[a-z0-9-]+(?::[0-9]+)?)$/,
} satisfies Record<ClassificationProvider, RegExp>;

const CREDENTIAL_BINDING = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  bedrock: "BEDROCK_API_KEY",
} as const satisfies Record<ClassificationProvider, keyof ClassificationEnv>;

/**
 * Parse a classification model id into its provider, the model id sent to
 * that provider, and the AWS Region for Bedrock.
 *
 * There is no separate provider env var: the model id alone selects the
 * provider. A prefixed id (`anthropic/...`, `openai/...`) sends the provider
 * the id after the prefix; a bare `claude-...` or `gpt-...` id is sent whole.
 *
 * Unlike `extractProviderAndModel` in `./models`, an unrecognized id throws
 * rather than silently falling back to Anthropic: a typo'd classifier model
 * should fail the request loudly, not bill the wrong provider.
 */
export function parseClassificationModel(modelId: string): ClassificationModel {
  const patterns = Object.entries(MODEL_ID_PATTERNS) as [ClassificationProvider, RegExp][];
  for (const [provider, pattern] of patterns) {
    // Every pattern names a group, so `groups` is set exactly when it matches.
    const groups = pattern.exec(modelId)?.groups;
    if (!groups) continue;
    const model = groups.model ?? modelId;
    return provider === "bedrock"
      ? { provider, region: groups.region, model }
      : { provider, model };
  }
  throw new Error(`Unrecognized classification model: ${modelId}`);
}

/**
 * Resolve the endpoint, credential, and model that serve the configured
 * classification model.
 *
 * Only the selected provider's key is bound to each classifier Worker. Throw
 * before any request when the binding and model selection disagree, rather
 * than reporting the provider's authentication error.
 */
export function resolveClassificationTarget(env: ClassificationEnv): ClassificationTarget {
  const modelId = env.CLASSIFICATION_MODEL || DEFAULT_CLASSIFICATION_MODEL;
  const parsed = parseClassificationModel(modelId);
  const binding = CREDENTIAL_BINDING[parsed.provider];
  const apiKey = env[binding];
  if (!apiKey) {
    throw new Error(`Classification model "${modelId}" requires ${binding} to be set`);
  }

  switch (parsed.provider) {
    case "anthropic":
      return {
        protocol: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        apiKey,
        model: parsed.model,
      };
    case "bedrock":
      return {
        protocol: "anthropic-messages",
        provider: "bedrock",
        baseUrl: `https://bedrock-runtime.${parsed.region}.amazonaws.com/anthropic`,
        apiKey,
        model: parsed.model,
      };
    case "openai":
      return { protocol: "openai-chat", provider: "openai", apiKey, model: parsed.model };
  }
}

/**
 * Envelope of an OpenAI Chat Completions response, validated before the
 * structured payload inside it is handed to a caller's own schema.
 */
export const openAiChatCompletionEnvelopeSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.string().nullable(),
        refusal: z.string().nullable().optional(),
      }),
    })
  ),
});

/**
 * Call OpenAI's Chat Completions API in strict structured-output mode and
 * return the parsed JSON payload.
 *
 * The result is deliberately `unknown`: each bot validates it against its own
 * schema, so this transport stays free of any one bot's result shape.
 *
 * No `temperature` is sent — gpt-5-family models accept only the default and
 * reject an explicit value with HTTP 400 `unsupported_value`.
 *
 * `reasoningEffort` is sent as `reasoning_effort` only when set; otherwise
 * OpenAI applies the model's default effort.
 */
export async function callOpenAIStructured(
  apiKey: string,
  model: string,
  prompt: string,
  schema: { name: string; schema: unknown },
  reasoningEffort?: string
): Promise<unknown> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      max_completion_tokens: OPENAI_CLASSIFICATION_MAX_COMPLETION_TOKENS,
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: schema.name,
          strict: true,
          schema: schema.schema,
        },
      },
    }),
    signal: AbortSignal.timeout(CLASSIFICATION_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(`OpenAI API error ${response.status}: ${body}`);
  }

  const envelope = openAiChatCompletionEnvelopeSchema.safeParse(await response.json());
  if (!envelope.success) {
    throw new Error("Malformed OpenAI response");
  }

  const message = envelope.data.choices[0]?.message;
  if (!message) {
    throw new Error("No choices in OpenAI response");
  }
  if (message.refusal) {
    throw new Error(`OpenAI refused to classify: ${message.refusal}`);
  }
  if (!message.content) {
    throw new Error("Empty OpenAI response content");
  }

  try {
    return JSON.parse(message.content);
  } catch {
    throw new Error("Failed to parse OpenAI response content as JSON");
  }
}
