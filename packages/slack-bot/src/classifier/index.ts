/**
 * Target classifier for the Slack bot.
 *
 * Uses an LLM to classify which target — a repository or a saved environment —
 * a Slack message refers to, based on message content, thread context, and
 * channel information.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Env, ThreadContext, ClassificationResult } from "../types";
import { buildRepoDescriptions } from "./repos";
import { buildEnvironmentDescriptions } from "./environments";
import { loadTargetCatalog, type TargetCatalog } from "./catalog";
import { matchTargetId, resolveChannelTargets, resolveRoutingRuleTargets } from "./routing";
import { escapeMrkdwnText } from "@open-inspect/shared/slack";
import {
  CLASSIFICATION_REQUEST_TIMEOUT_MS,
  callOpenAIStructured,
  resolveClassificationTarget,
  type AnthropicMessagesTarget,
  type ClassificationTarget,
  type OpenAIChatTarget,
} from "@open-inspect/shared/classification";
import {
  NO_REPOSITORY_TARGET_VALUE,
  targetId,
  targetLabel,
  targetValue,
  type SlackSessionTarget,
} from "../targets";
import { createLogger } from "../logger";

const log = createLogger("classifier");
const CLASSIFY_TARGET_TOOL_NAME = "classify_target";
const CLASSIFY_TARGET_SYSTEM_PROMPT = `Answer by calling the ${CLASSIFY_TARGET_TOOL_NAME} tool exactly once. Do not reply in plain text.`;
const CONFIDENCE_LEVELS = [
  "high",
  "medium",
  "low",
] as const satisfies readonly ClassificationResult["confidence"][];

const CLASSIFY_TARGET_TOOL: Anthropic.Messages.Tool = {
  name: CLASSIFY_TARGET_TOOL_NAME,
  description:
    "Classify which repository, environment, or repository-less sandbox a Slack message needs. " +
    "Use targetId as null when uncertain.",
  input_schema: {
    type: "object",
    properties: {
      targetId: {
        type: ["string", "null"],
        description: `A repository "owner/name", an environment id ("env_…"), or "${NO_REPOSITORY_TARGET_VALUE}". Use null when unclear.`,
      },
      confidence: {
        type: "string",
        enum: CONFIDENCE_LEVELS,
      },
      reasoning: {
        type: "string",
        description: "Brief explanation of classification decision.",
      },
      alternatives: {
        type: "array",
        items: { type: "string" },
        description: `Other reasonable repository fullNames, environment ids, or "${NO_REPOSITORY_TARGET_VALUE}", especially whenever clarification may be required.`,
      },
    },
    required: ["targetId", "confidence", "reasoning", "alternatives"],
    additionalProperties: false,
  },
};

/**
 * Build the classification prompt for the LLM over the target catalog.
 */
function buildClassificationPrompt(
  message: string,
  catalog: TargetCatalog,
  context?: ThreadContext
): string {
  const repoDescriptions = buildRepoDescriptions(catalog.repos);

  const environmentSection =
    catalog.environments.length > 0
      ? `
## Available Environments

Environments are saved multi-repository workspaces. Prefer an environment over a
single repository when the message names it, or when the work spans several of
its repositories.
${buildEnvironmentDescriptions(catalog.environments)}
`
      : "";

  let contextSection = "";

  if (context) {
    contextSection = `
## Context

**Channel**: ${context.channelName ? `#${context.channelName}` : context.channelId}
${context.channelDescription ? `**Channel Description**: ${context.channelDescription}` : ""}
${context.threadTs ? `**In Thread**: Yes` : "**In Thread**: No"}
${
  context.previousMessages?.length
    ? `**Previous Messages in Thread**:
${context.previousMessages.map((m) => `- ${m}`).join("\n")}`
    : ""
}`;
  }

  return `You are a target classifier for a coding agent. Your job is to determine which repository, environment, or repository-less sandbox a Slack message needs.

## Available Repositories
${repoDescriptions}
${environmentSection}

## No Repository Target

Use targetId "${NO_REPOSITORY_TARGET_VALUE}" when the task should run in an empty sandbox without cloning a repository.
Choose this target when the task does not require any available repository or environment. Include likely repository targets as alternatives when applicable.
${contextSection}

## User's Message
${message}

## Your Task

Analyze the message and context to determine which target the user needs.

Consider:
1. Explicit mentions of repository or environment names or aliases
2. Technical keywords that match repository technologies
3. File paths or code patterns mentioned
4. Channel associations (some channels are associated with specific repos)
5. Context from previous messages in the thread
6. Whether the task requires any repository at all

## Response Format

Respond with a JSON object with these fields:
- targetId: a repository "owner/name", an environment id ("env_…"), "${NO_REPOSITORY_TARGET_VALUE}", or null if unclear
- confidence: "high" | "medium" | "low"
- reasoning: brief explanation
- alternatives: other reasonable targets, especially whenever clarification may be required`;
}

const llmResponseSchema = z.object({
  targetId: z
    .union([z.string(), z.null()])
    .transform((value) => (typeof value === "string" && value.trim() ? value.trim() : null)),
  confidence: z
    .string()
    .transform((value) => value.trim().toLowerCase())
    .pipe(z.enum(CONFIDENCE_LEVELS)),
  reasoning: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1)),
  alternatives: z
    .array(
      z
        .string()
        .transform((value) => value.trim())
        .pipe(z.string().min(1))
    )
    .transform((values) => [...new Set(values)]),
});

type LLMResponse = z.infer<typeof llmResponseSchema>;

function normalizeModelResponse(raw: unknown): LLMResponse {
  const parsed = llmResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Invalid LLM response");
  }
  return parsed.data;
}

function extractStructuredResponse(response: Anthropic.Messages.Message): LLMResponse {
  const toolUseBlock = response.content.find(
    (block): block is Anthropic.Messages.ToolUseBlock =>
      block.type === "tool_use" && block.name === CLASSIFY_TARGET_TOOL_NAME
  );

  if (!toolUseBlock) {
    throw new Error("No structured tool_use classification in LLM response");
  }

  return normalizeModelResponse(toolUseBlock.input);
}

/**
 * Call OpenAI's Chat Completions API with strict JSON-schema structured
 * output, then funnel the parsed object through the same
 * {@link normalizeModelResponse} validation as the Anthropic tool-use path.
 *
 * The Anthropic tool's `input_schema` already carries
 * `additionalProperties: false`, which is what OpenAI's `strict` mode requires,
 * so both providers are driven from that one declaration.
 */
async function callOpenAI(
  target: OpenAIChatTarget,
  prompt: string,
  reasoningEffort?: string
): Promise<LLMResponse> {
  const parsed = await callOpenAIStructured(
    target.apiKey,
    target.model,
    prompt,
    {
      name: CLASSIFY_TARGET_TOOL_NAME,
      schema: CLASSIFY_TARGET_TOOL.input_schema,
    },
    reasoningEffort
  );

  return normalizeModelResponse(parsed);
}

/**
 * Repository classifier class.
 */
export class RepoClassifier {
  private anthropicClient: Anthropic | null = null;
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Lazily construct the Anthropic client so an OpenAI-configured deployment
   * never builds one. The target comes from this classifier's fixed env, so
   * the first call's client serves every later one.
   *
   * The key goes in `apiKey`, never `authToken`, because Claude in Amazon
   * Bedrock reads its API key from the same `x-api-key` header as the Anthropic
   * API.
   */
  private getAnthropicClient(target: AnthropicMessagesTarget): Anthropic {
    if (!this.anthropicClient) {
      this.anthropicClient = new Anthropic({ apiKey: target.apiKey, baseURL: target.baseUrl });
    }
    return this.anthropicClient;
  }

  /**
   * Call the Messages API (Anthropic or Claude in Amazon Bedrock) with the
   * classification tool, then funnel the tool input through the same
   * {@link normalizeModelResponse} validation as the OpenAI structured-output
   * path.
   *
   * Claude Opus 4.7 and later reject a non-default `temperature`, and Opus 5.5
   * rejects a forced tool call, each with HTTP 400, so the system prompt asks
   * for the call instead and a text reply falls back to the picker.
   */
  private async callAnthropic(
    target: AnthropicMessagesTarget,
    prompt: string
  ): Promise<LLMResponse> {
    const response = await this.getAnthropicClient(target).messages.create(
      {
        model: target.model,
        max_tokens: 500,
        system: CLASSIFY_TARGET_SYSTEM_PROMPT,
        tools: [CLASSIFY_TARGET_TOOL],
        tool_choice: { type: "auto", disable_parallel_tool_use: true },
        messages: [{ role: "user", content: prompt }],
      },
      { signal: AbortSignal.timeout(CLASSIFICATION_REQUEST_TIMEOUT_MS) }
    );

    return extractStructuredResponse(response);
  }

  /**
   * Match the message against the workspace's Slack routing rules (resolution
   * lives in {@link resolveRoutingRuleTargets}).
   *
   * Returns a high-confidence result when exactly one accessible target matches,
   * a clarification result when several distinct targets match (so the user
   * picks rather than the bot guessing), or `null` when no rule applies — in
   * which case the caller falls through to channel association and the LLM.
   */
  private async classifyByRoutingRules(
    message: string,
    catalog: TargetCatalog,
    traceId?: string
  ): Promise<ClassificationResult | null> {
    const resolved = await resolveRoutingRuleTargets(this.env, message, catalog, traceId);
    if (resolved.length === 0) return null;

    if (resolved.length === 1) {
      const { target, keyword } = resolved[0];
      log.info("classifier.routing_rule_match", {
        trace_id: traceId,
        target_id: targetId(target),
        keyword,
      });
      return {
        target,
        confidence: "high",
        // Reasoning renders as mrkdwn; keyword and label are both user text.
        reasoning: `Matched routing rule "${escapeMrkdwnText(keyword)}" → ${escapeMrkdwnText(targetLabel(target))}`,
        needsClarification: false,
        source: "routing_rule",
      };
    }

    return {
      target: null,
      confidence: "medium",
      reasoning: "Multiple routing rules matched; asking which one to use.",
      alternatives: resolved.map((t) => t.target),
      needsClarification: true,
      source: "routing_rule",
    };
  }

  /**
   * Route on the channel's associated targets (resolution lives in
   * {@link resolveChannelTargets}).
   *
   * Returns a high-confidence result when the channel is associated with
   * exactly one target. Several associated repositories fall through (`null`)
   * to the LLM, which is told to weigh channel context — but channel
   * associations themselves aren't part of its prompt signal, so a
   * multi-target set that includes an environment asks the user
   * deterministically instead of letting the model drop the association.
   */
  private classifyByChannelAssociations(
    channelId: string,
    catalog: TargetCatalog,
    traceId?: string
  ): ClassificationResult | null {
    const targets = resolveChannelTargets(catalog, channelId);

    if (targets.length === 1) {
      const target = targets[0];
      log.info("classifier.channel_association_match", {
        trace_id: traceId,
        channel_id: channelId,
        target_id: targetId(target),
      });
      return {
        target,
        confidence: "high",
        // Reasoning renders as mrkdwn; the label is user text.
        reasoning: `Channel is associated with ${target.kind} ${escapeMrkdwnText(targetLabel(target))}`,
        needsClarification: false,
        source: "channel_association",
      };
    }

    if (targets.length > 1 && targets.some((target) => target.kind === "environment")) {
      return {
        target: null,
        confidence: "medium",
        reasoning: "This channel is associated with several targets; asking which one to use.",
        alternatives: targets,
        needsClarification: true,
        source: "channel_association",
      };
    }

    return null;
  }

  /**
   * Classify which target a message refers to.
   */
  async classify(
    message: string,
    context?: ThreadContext,
    traceId?: string
  ): Promise<ClassificationResult> {
    // The target catalog every stage below works over. Environments fail open
    // to []: an environments-fetch problem degrades the catalog — and with it
    // classification — to repository-only.
    const catalog = await loadTargetCatalog(this.env, traceId, context?.channelId, context?.userId);

    // Deterministic routing rules (explicit keyword → repo or environment) take
    // precedence over everything below, but never override an active thread
    // (handled before classify is called).
    const routed = await this.classifyByRoutingRules(message, catalog, traceId);
    if (routed) {
      return routed;
    }

    // Channel associations are the second deterministic stage.
    const channelRouted = context?.channelId
      ? this.classifyByChannelAssociations(context.channelId, catalog, traceId)
      : null;
    if (channelRouted) {
      return channelRouted;
    }

    // Use LLM for classification
    const offerPicker = (
      e: unknown,
      provider?: ClassificationTarget["provider"]
    ): ClassificationResult => {
      log.error("classifier.classify", {
        trace_id: traceId,
        method: "llm",
        provider,
        outcome: "error",
        error: e instanceof Error ? e : new Error(String(e)),
        channel_id: context?.channelId,
      });

      return {
        target: null,
        confidence: "low",
        reasoning:
          "Could not classify a target from structured model output. Please pick one below.",
        // No basis to suggest specific targets on a classification failure;
        // the picker lets the user search the full list.
        alternatives: undefined,
        needsClarification: true,
        source: "llm",
      };
    };

    let llmTarget: ClassificationTarget;
    try {
      llmTarget = resolveClassificationTarget(this.env);
    } catch (e) {
      return offerPicker(e);
    }

    try {
      const prompt = buildClassificationPrompt(message, catalog, context);
      const llmResult =
        llmTarget.protocol === "anthropic-messages"
          ? await this.callAnthropic(llmTarget, prompt)
          : await callOpenAI(llmTarget, prompt, this.env.CLASSIFICATION_REASONING_EFFORT);

      const matchedTarget = llmResult.targetId ? matchTargetId(llmResult.targetId, catalog) : null;

      // Resolve alternatives, deduplicated and never repeating the match.
      const alternatives: SlackSessionTarget[] = [];
      for (const altId of llmResult.alternatives) {
        const target = matchTargetId(altId, catalog);
        if (
          target &&
          (!matchedTarget || targetValue(target) !== targetValue(matchedTarget)) &&
          !alternatives.some((existing) => targetValue(existing) === targetValue(target))
        ) {
          alternatives.push(target);
        }
      }

      return {
        target: matchedTarget,
        confidence: llmResult.confidence,
        // Reasoning renders as mrkdwn and may quote target names or message
        // text; escape it at composition like the deterministic stages do.
        reasoning: escapeMrkdwnText(llmResult.reasoning),
        alternatives: alternatives.length > 0 ? alternatives : undefined,
        needsClarification:
          !matchedTarget ||
          llmResult.confidence === "low" ||
          (llmResult.confidence === "medium" && alternatives.length > 0),
        source: "llm",
      };
    } catch (e) {
      return offerPicker(e, llmTarget.provider);
    }
  }
}

/**
 * Create a new classifier instance.
 */
export function createClassifier(env: Env): RepoClassifier {
  return new RepoClassifier(env);
}
