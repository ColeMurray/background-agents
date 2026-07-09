/**
 * Target classifier for the Slack bot.
 *
 * Uses an LLM to classify which target — a repository or a saved environment —
 * a Slack message refers to, based on message content, thread context, and
 * channel information.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Env, Environment, RepoConfig, ThreadContext, ClassificationResult } from "../types";
import { getAvailableRepos, buildRepoDescriptions } from "./repos";
import { buildEnvironmentDescriptions, getAvailableEnvironments } from "./environments";
import { matchTargetId, resolveChannelTargets, resolveRoutingRuleTargets } from "./routing";
import { escapeMrkdwnText, type ConfidenceLevel } from "@open-inspect/shared";
import { targetId, targetLabel, targetValue, type SlackSessionTarget } from "../targets";
import { createLogger } from "../logger";

const log = createLogger("classifier");
const CLASSIFY_TARGET_TOOL_NAME = "classify_target";
const CONFIDENCE_LEVELS: ClassificationResult["confidence"][] = ["high", "medium", "low"];

const CLASSIFY_TARGET_TOOL: Anthropic.Messages.Tool = {
  name: CLASSIFY_TARGET_TOOL_NAME,
  description:
    "Classify which repository or environment a Slack message refers to. " +
    "Use targetId as null when uncertain.",
  input_schema: {
    type: "object",
    properties: {
      targetId: {
        type: ["string", "null"],
        description:
          'A repository "owner/name" or an environment id ("env_…") if confident enough to choose one, otherwise null.',
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
        description:
          "Alternative repository fullNames / environment ids when confidence is not high.",
      },
    },
    required: ["targetId", "confidence", "reasoning", "alternatives"],
    additionalProperties: false,
  },
};

/**
 * Build the classification prompt for the LLM.
 */
async function buildClassificationPrompt(
  env: Env,
  message: string,
  environments: Environment[],
  context?: ThreadContext,
  traceId?: string
): Promise<string> {
  const repoDescriptions = await buildRepoDescriptions(env, traceId);

  const environmentSection =
    environments.length > 0
      ? `
## Available Environments

Environments are saved multi-repository workspaces. Prefer an environment over a
single repository when the message names it, or when the work spans several of
its repositories.
${buildEnvironmentDescriptions(environments)}
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

  return `You are a target classifier for a coding agent. Your job is to determine which code repository or environment a Slack message is referring to.

## Available Repositories
${repoDescriptions}
${environmentSection}
${contextSection}

## User's Message
${message}

## Your Task

Analyze the message and context to determine which repository or environment the user is referring to.

Consider:
1. Explicit mentions of repository or environment names or aliases
2. Technical keywords that match repository technologies
3. File paths or code patterns mentioned
4. Channel associations (some channels are associated with specific repos)
5. Context from previous messages in the thread

## Response Format

Return your decision by calling the ${CLASSIFY_TARGET_TOOL_NAME} tool with:
- targetId: a repository "owner/name", an environment id ("env_…"), or null if unclear
- confidence: "high" | "medium" | "low"
- reasoning: brief explanation
- alternatives: other possible targets when confidence is not high`;
}

/**
 * Parse the LLM response into a structured result.
 */
interface LLMResponse {
  targetId: string | null;
  confidence: ConfidenceLevel;
  reasoning: string;
  alternatives: string[];
}

function normalizeModelResponse(raw: unknown): LLMResponse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("LLM response was not an object");
  }

  const input = raw as Record<string, unknown>;
  const rawTargetId = input.targetId;
  const targetId =
    rawTargetId === null
      ? null
      : typeof rawTargetId === "string" && rawTargetId.trim().length > 0
        ? rawTargetId.trim()
        : null;

  const rawConfidence = typeof input.confidence === "string" ? input.confidence.trim() : "";
  const confidence = rawConfidence.toLowerCase();
  if (!CONFIDENCE_LEVELS.includes(confidence as ClassificationResult["confidence"])) {
    throw new Error(`Invalid confidence value: ${rawConfidence || String(input.confidence)}`);
  }

  if (typeof input.reasoning !== "string" || input.reasoning.trim().length === 0) {
    throw new Error("Missing reasoning in LLM response");
  }

  if (!Array.isArray(input.alternatives)) {
    throw new Error("Alternatives must be an array");
  }

  const alternatives = input.alternatives
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (alternatives.length !== input.alternatives.length) {
    throw new Error("Invalid alternatives in LLM response");
  }

  return {
    targetId,
    confidence: confidence as ClassificationResult["confidence"],
    reasoning: input.reasoning.trim(),
    alternatives: [...new Set(alternatives)],
  };
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
 * Repository classifier class.
 */
export class RepoClassifier {
  private client: Anthropic;
  private env: Env;

  constructor(env: Env) {
    this.env = env;
    this.client = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
    });
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
    repos: RepoConfig[],
    traceId?: string
  ): Promise<ClassificationResult | null> {
    const resolved = await resolveRoutingRuleTargets(this.env, message, repos, traceId);
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
      };
    }

    return {
      target: null,
      confidence: "medium",
      reasoning: "Multiple routing rules matched; asking which one to use.",
      alternatives: resolved.map((t) => t.target),
      needsClarification: true,
    };
  }

  /**
   * Route on the channel's associated targets (resolution lives in
   * {@link resolveChannelTargets}).
   *
   * Returns a high-confidence result when the channel is associated with
   * exactly one target. Several associated repositories fall through (`null`)
   * to the LLM, which already sees channel associations as a prompt signal —
   * but the LLM cannot pick an environment until environments join its
   * candidate set (Phase B), so a multi-target set that includes an
   * environment asks the user instead of silently dropping it.
   */
  private async classifyByChannelAssociations(
    channelId: string,
    repos: RepoConfig[],
    traceId?: string
  ): Promise<ClassificationResult | null> {
    const targets = await resolveChannelTargets(this.env, channelId, repos, traceId);

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
      };
    }

    if (targets.length > 1 && targets.some((target) => target.kind === "environment")) {
      return {
        target: null,
        confidence: "medium",
        reasoning: "This channel is associated with several targets; asking which one to use.",
        alternatives: targets,
        needsClarification: true,
      };
    }

    return null;
  }

  /**
   * Classify which repository a message refers to.
   */
  async classify(
    message: string,
    context?: ThreadContext,
    traceId?: string
  ): Promise<ClassificationResult> {
    // Fetch available repos dynamically
    const repos = await getAvailableRepos(this.env, traceId);

    // If no repos available, return immediately
    if (repos.length === 0) {
      return {
        target: null,
        confidence: "low",
        reasoning: "No repositories are currently available.",
        needsClarification: true,
      };
    }

    // Deterministic routing rules (explicit keyword → repo or environment) take
    // precedence over everything below — including the single-repo shortcut,
    // which would otherwise make environment-targeted rules unreachable in
    // one-repo workspaces — but never override an active thread (handled before
    // classify is called).
    const routed = await this.classifyByRoutingRules(message, repos, traceId);
    if (routed) {
      return routed;
    }

    // Channel associations are the second deterministic stage. Like routing
    // rules, they run before the single-repo shortcut so a channel associated
    // with an environment stays reachable in one-repo workspaces.
    const channelRouted = context?.channelId
      ? await this.classifyByChannelAssociations(context.channelId, repos, traceId)
      : null;
    if (channelRouted) {
      return channelRouted;
    }

    // Environments join the LLM's candidate set (fail-open []: an
    // environments-fetch problem degrades to repository-only classification).
    const environments = await getAvailableEnvironments(this.env, traceId);

    // With a single repository and no environments there is nothing to choose.
    if (repos.length === 1 && environments.length === 0) {
      return {
        target: { kind: "repository", repo: repos[0] },
        confidence: "high",
        reasoning: "Only one repository is available.",
        needsClarification: false,
      };
    }

    // Use LLM for classification
    try {
      const prompt = await buildClassificationPrompt(
        this.env,
        message,
        environments,
        context,
        traceId
      );

      const response = await this.client.messages.create({
        model: this.env.CLASSIFICATION_MODEL || "claude-haiku-4-5",
        max_tokens: 500,
        temperature: 0,
        tools: [CLASSIFY_TARGET_TOOL],
        tool_choice: {
          type: "tool",
          name: CLASSIFY_TARGET_TOOL_NAME,
          disable_parallel_tool_use: true,
        },
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      });

      const llmResult = extractStructuredResponse(response);

      const matchedTarget = llmResult.targetId
        ? matchTargetId(llmResult.targetId, repos, environments)
        : null;

      // Resolve alternatives, deduplicated and never repeating the match.
      const alternatives: SlackSessionTarget[] = [];
      for (const altId of llmResult.alternatives) {
        const target = matchTargetId(altId, repos, environments);
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
      };
    } catch (e) {
      log.error("classifier.classify", {
        trace_id: traceId,
        method: "llm",
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
      };
    }
  }
}

/**
 * Create a new classifier instance.
 */
export function createClassifier(env: Env): RepoClassifier {
  return new RepoClassifier(env);
}
