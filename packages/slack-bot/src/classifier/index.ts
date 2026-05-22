/**
 * Repository classifier for the Slack bot.
 *
 * Uses an LLM to classify which repository a Slack message refers to,
 * based on message content, thread context, and channel information.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Env, RepoConfig, ThreadContext, ClassificationResult } from "../types";
import type { ConfidenceLevel } from "@open-inspect/shared";
import { getAvailableRepos, buildRepoDescriptions, getReposByChannel } from "./repos";
import { createLogger } from "../logger";

const log = createLogger("classifier");
const CLASSIFY_REPO_TOOL_NAME = "classify_repository";
const CONFIDENCE_LEVELS: ClassificationResult["confidence"][] = ["high", "medium", "low"];

const CLASSIFY_REPO_TOOL: Anthropic.Messages.Tool = {
  name: CLASSIFY_REPO_TOOL_NAME,
  description:
    "Classify which repository a Slack message refers to AND whether the task warrants a human-approved plan before code changes.",
  input_schema: {
    type: "object",
    properties: {
      repoId: {
        type: ["string", "null"],
        description: "Repository ID/fullName if confident enough to choose one, otherwise null.",
      },
      confidence: {
        type: "string",
        enum: CONFIDENCE_LEVELS,
      },
      reasoning: {
        type: "string",
        description: "Brief explanation of repository classification decision.",
      },
      alternatives: {
        type: "array",
        items: { type: "string" },
        description: "Alternative repository IDs/fullNames when confidence is not high.",
      },
      shouldPlan: {
        type: "boolean",
        description:
          "True if the task is non-trivial enough to warrant a plan before code changes (multi-step refactor, design question, architectural decision, multi-file changes). False for trivial fixes, well-scoped small changes, questions, or quick tweaks. Default to false when uncertain to reduce friction.",
      },
      planReasoning: {
        type: "string",
        description: "Brief explanation of the plan-vs-build decision.",
      },
    },
    required: ["repoId", "confidence", "reasoning", "alternatives", "shouldPlan", "planReasoning"],
    additionalProperties: false,
  },
};

const CLASSIFY_PLAN_TOOL_NAME = "classify_plan_intent";
const CLASSIFY_PLAN_TOOL: Anthropic.Messages.Tool = {
  name: CLASSIFY_PLAN_TOOL_NAME,
  description:
    "Decide whether a Slack coding request warrants a human-approved plan before code changes.",
  input_schema: {
    type: "object",
    properties: {
      shouldPlan: {
        type: "boolean",
        description:
          "True if the task is non-trivial (multi-step refactor, design question, architectural decision). False for trivial fixes, well-scoped small changes, questions, or quick tweaks. Default to false when uncertain to reduce friction.",
      },
      planReasoning: {
        type: "string",
        description: "Brief explanation of the decision.",
      },
    },
    required: ["shouldPlan", "planReasoning"],
    additionalProperties: false,
  },
};

function buildPlanIntentPrompt(message: string, threadContext: string): string {
  return `You are deciding whether a coding agent should propose a plan before making code changes, or build directly.

## User's message
${message}${threadContext}

## Decision rules

Set \`shouldPlan: true\` when the task is non-trivial:
- Multi-step refactor, redesign, or migration
- New feature spanning multiple files
- Architectural decision or "how should we" questions
- Anything where reviewing the approach before code changes adds clear value

Set \`shouldPlan: false\` when the task is well-scoped and quick:
- Bug fix with a clear scope
- Typo, rename, or small enhancement
- Questions that don't require code changes
- Explicit "just do X", "quick fix", "small change", or similar
- Pure investigation / read-only requests

When uncertain, prefer \`false\` (build mode) to reduce friction.

Call the ${CLASSIFY_PLAN_TOOL_NAME} tool with your decision.`;
}

/**
 * Build the classification prompt for the LLM.
 */
async function buildClassificationPrompt(
  env: Env,
  message: string,
  context?: ThreadContext,
  traceId?: string
): Promise<string> {
  const repoDescriptions = await buildRepoDescriptions(env, traceId);

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

  return `You are a classifier for a coding agent triggered from Slack. You have two decisions to make:
1. Which repository the user's message refers to.
2. Whether the task warrants a human-approved plan before any code changes ("plan mode"), or should go straight to building ("build mode").

## Available Repositories
${repoDescriptions}

${contextSection}

## User's Message
${message}

## Repository Decision

Consider:
1. Explicit mentions of repository names or aliases
2. Technical keywords that match repository technologies
3. File paths or code patterns mentioned
4. Channel associations (some channels are associated with specific repos)
5. Context from previous messages in the thread

## Plan-vs-Build Decision

Set \`shouldPlan: true\` when the task is non-trivial:
- Multi-step refactor, redesign, or migration
- New feature spanning multiple files
- Architectural decision or "how should we" questions
- Anything where reviewing the approach before code changes adds clear value

Set \`shouldPlan: false\` when the task is well-scoped and quick:
- Bug fix with a clear scope
- Typo, rename, or small enhancement
- Questions that don't require code changes
- Explicit "just do X", "quick fix", "small change", or similar
- Pure investigation / read-only requests

When uncertain, prefer \`false\` (build mode) to reduce friction. The user can always re-prompt for a plan.

## Response Format

Call the ${CLASSIFY_REPO_TOOL_NAME} tool with:
- repoId: "owner/name" or null if unclear
- confidence: "high" | "medium" | "low" (for the repo choice)
- reasoning: brief explanation of the repo choice
- alternatives: other possible repos when confidence is not high
- shouldPlan: true | false
- planReasoning: brief explanation of the plan-vs-build choice`;
}

/**
 * Parse the LLM response into a structured result.
 */
interface LLMResponse {
  repoId: string | null;
  confidence: ConfidenceLevel;
  reasoning: string;
  alternatives: string[];
  shouldPlan: boolean;
  planReasoning: string;
}

function normalizeModelResponse(raw: unknown): LLMResponse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("LLM response was not an object");
  }

  const input = raw as Record<string, unknown>;
  const rawRepoId = input.repoId;
  const repoId =
    rawRepoId === null
      ? null
      : typeof rawRepoId === "string" && rawRepoId.trim().length > 0
        ? rawRepoId.trim()
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

  if (typeof input.shouldPlan !== "boolean") {
    throw new Error("Missing or invalid shouldPlan in LLM response");
  }

  if (typeof input.planReasoning !== "string" || input.planReasoning.trim().length === 0) {
    throw new Error("Missing planReasoning in LLM response");
  }

  return {
    repoId,
    confidence: confidence as ClassificationResult["confidence"],
    reasoning: input.reasoning.trim(),
    alternatives: [...new Set(alternatives)],
    shouldPlan: input.shouldPlan,
    planReasoning: input.planReasoning.trim(),
  };
}

function extractStructuredResponse(response: Anthropic.Messages.Message): LLMResponse {
  const toolUseBlock = response.content.find(
    (block): block is Anthropic.Messages.ToolUseBlock =>
      block.type === "tool_use" && block.name === CLASSIFY_REPO_TOOL_NAME
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
        repo: null,
        confidence: "low",
        reasoning: "No repositories are currently available.",
        needsClarification: true,
      };
    }

    // Fast paths still need a plan-vs-build classification so single-repo
    // users benefit from smart plan detection. We make a lightweight LLM
    // call for that signal and skip the (trivial) repo classification.
    if (repos.length === 1) {
      const plan = await this.classifyPlanIntent(message, context, traceId);
      return {
        repo: repos[0],
        confidence: "high",
        reasoning: "Only one repository is available.",
        needsClarification: false,
        ...plan,
      };
    }

    if (context?.channelId) {
      const channelRepos = await getReposByChannel(this.env, context.channelId, traceId);
      if (channelRepos.length === 1) {
        const plan = await this.classifyPlanIntent(message, context, traceId);
        return {
          repo: channelRepos[0],
          confidence: "high",
          reasoning: `Channel is associated with repository ${channelRepos[0].fullName}`,
          needsClarification: false,
          ...plan,
        };
      }
    }

    // Use LLM for classification
    try {
      const prompt = await buildClassificationPrompt(this.env, message, context, traceId);

      const response = await this.client.messages.create({
        model: this.env.CLASSIFICATION_MODEL || "claude-haiku-4-5",
        max_tokens: 500,
        temperature: 0,
        tools: [CLASSIFY_REPO_TOOL],
        tool_choice: {
          type: "tool",
          name: CLASSIFY_REPO_TOOL_NAME,
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

      // Find the matched repo
      let matchedRepo: RepoConfig | null = null;
      if (llmResult.repoId) {
        matchedRepo =
          repos.find(
            (r) =>
              r.id.toLowerCase() === llmResult.repoId!.toLowerCase() ||
              r.fullName.toLowerCase() === llmResult.repoId!.toLowerCase()
          ) || null;
      }

      // Find alternative repos
      const alternatives: RepoConfig[] = [];
      for (const altId of llmResult.alternatives) {
        const altRepo = repos.find(
          (r) =>
            r.id.toLowerCase() === altId.toLowerCase() ||
            r.fullName.toLowerCase() === altId.toLowerCase()
        );
        if (altRepo && altRepo.id !== matchedRepo?.id) {
          alternatives.push(altRepo);
        }
      }

      return {
        repo: matchedRepo,
        confidence: llmResult.confidence,
        reasoning: llmResult.reasoning,
        alternatives: alternatives.length > 0 ? alternatives : undefined,
        needsClarification:
          !matchedRepo ||
          llmResult.confidence === "low" ||
          (llmResult.confidence === "medium" && alternatives.length > 0),
        shouldPlan: llmResult.shouldPlan,
        planReasoning: llmResult.planReasoning,
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
        repo: null,
        confidence: "low",
        reasoning:
          "Could not classify repository from structured model output. Please select a repository.",
        alternatives: repos.slice(0, 5),
        needsClarification: true,
      };
    }
  }

  /**
   * Lightweight LLM call that decides plan-vs-build for the given prompt.
   * Used by the fast paths (single repo, channel-bound) so users with only
   * one repo configured still benefit from smart plan detection.
   *
   * Returns `{ shouldPlan: false }` on any error so a classifier failure
   * never blocks a build — the user can still re-prompt for a plan.
   */
  private async classifyPlanIntent(
    message: string,
    context?: ThreadContext,
    traceId?: string
  ): Promise<{ shouldPlan?: boolean; planReasoning?: string }> {
    try {
      const threadContext = context?.previousMessages?.length
        ? `\n\n## Previous messages in thread\n${context.previousMessages.map((m) => `- ${m}`).join("\n")}`
        : "";

      const response = await this.client.messages.create({
        model: this.env.CLASSIFICATION_MODEL || "claude-haiku-4-5",
        max_tokens: 200,
        temperature: 0,
        tools: [CLASSIFY_PLAN_TOOL],
        tool_choice: {
          type: "tool",
          name: CLASSIFY_PLAN_TOOL_NAME,
          disable_parallel_tool_use: true,
        },
        messages: [
          {
            role: "user",
            content: buildPlanIntentPrompt(message, threadContext),
          },
        ],
      });

      const toolUseBlock = response.content.find(
        (block): block is Anthropic.Messages.ToolUseBlock =>
          block.type === "tool_use" && block.name === CLASSIFY_PLAN_TOOL_NAME
      );
      if (!toolUseBlock) return { shouldPlan: false };
      const input = toolUseBlock.input as Record<string, unknown>;
      const shouldPlan = typeof input.shouldPlan === "boolean" ? input.shouldPlan : false;
      const planReasoning =
        typeof input.planReasoning === "string" && input.planReasoning.trim().length > 0
          ? input.planReasoning.trim()
          : undefined;
      return { shouldPlan, planReasoning };
    } catch (e) {
      log.warn("classifier.classify_plan_intent", {
        trace_id: traceId,
        outcome: "error",
        error: e instanceof Error ? e : new Error(String(e)),
      });
      return { shouldPlan: false };
    }
  }
}

/**
 * Create a new classifier instance.
 */
export function createClassifier(env: Env): RepoClassifier {
  return new RepoClassifier(env);
}
