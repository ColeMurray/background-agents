/**
 * Shared plumbing for the Slack and Linear bots' target classifiers.
 *
 * Both bots pick a classification provider from the model id alone and, on the
 * OpenAI path, speak the same strict structured-output dialect of the Chat
 * Completions API. Only that provider-selection and transport layer lives here;
 * each bot keeps its own response validation, prompt, and Anthropic transport.
 */

import { z } from "zod";

/** Provider serving a classification request. */
export type ClassificationProvider = "anthropic" | "openai";

/**
 * Model the classifiers use when a deployment sets no override.
 */
export const DEFAULT_CLASSIFICATION_MODEL = "claude-haiku-4-5";

/**
 * Bound on a single classification request to either provider, so a stalled
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
 * Resolve which provider serves a classification model id, and the bare id to
 * send that provider (any `anthropic/`/`openai/` prefix stripped).
 *
 * There is no separate provider env var — the model id alone selects the
 * provider, so `CLASSIFICATION_MODEL=gpt-5.4-mini` routes to OpenAI while the
 * default {@link DEFAULT_CLASSIFICATION_MODEL} keeps routing to Anthropic.
 *
 * Unlike `extractProviderAndModel` in `./models`, an unrecognized id throws
 * rather than silently falling back to Anthropic: a typo'd classifier model
 * should fail the request loudly, not bill the wrong provider.
 */
export function resolveClassificationProvider(modelId: string): {
  provider: ClassificationProvider;
  model: string;
} {
  if (modelId.startsWith("anthropic/")) {
    return { provider: "anthropic", model: modelId.slice("anthropic/".length) };
  }
  if (modelId.startsWith("openai/")) {
    return { provider: "openai", model: modelId.slice("openai/".length) };
  }
  if (modelId.startsWith("claude-")) {
    return { provider: "anthropic", model: modelId };
  }
  if (modelId.startsWith("gpt-")) {
    return { provider: "openai", model: modelId };
  }
  throw new Error(`Unrecognized classification model: ${modelId}`);
}

/**
 * Read the provider credential required by a resolved classification model.
 *
 * Only the selected provider's key is bound to each classifier Worker. Fail
 * before the outbound request when the binding and model selection disagree,
 * rather than reporting the provider's authentication error.
 */
export function requireClassificationProviderKey(
  key: string | undefined,
  binding: "ANTHROPIC_API_KEY" | "OPENAI_API_KEY",
  modelId: string
): string {
  if (!key) {
    throw new Error(`Classification model "${modelId}" requires ${binding} to be set`);
  }
  return key;
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
 */
export async function callOpenAIStructured(
  apiKey: string,
  model: string,
  prompt: string,
  schema: { name: string; schema: unknown }
): Promise<unknown> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
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
