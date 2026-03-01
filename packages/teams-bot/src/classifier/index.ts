/**
 * Repository classifier for the Teams bot.
 *
 * Uses an LLM to classify which repository a Teams message refers to,
 * based on message content, thread context, and channel information.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Env, RepoConfig, ThreadContext, ClassificationResult } from "../types";
import { getAvailableRepos, buildRepoDescriptions, getReposByChannel } from "./repos";
import { createLogger } from "../logger";

const log = createLogger("classifier");
const CLASSIFY_REPO_TOOL_NAME = "classify_repository";
const CONFIDENCE_LEVELS: ClassificationResult["confidence"][] = ["high", "medium", "low"];

const CLASSIFY_REPO_TOOL: Anthropic.Messages.Tool = {
  name: CLASSIFY_REPO_TOOL_NAME,
  description:
    "Classify which repository a Teams message refers to. Use repoId as null when uncertain.",
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
        description: "Brief explanation of classification decision.",
      },
      alternatives: {
        type: "array",
        items: { type: "string" },
        description: "Alternative repository IDs/fullNames when confidence is not high.",
      },
    },
    required: ["repoId", "confidence", "reasoning", "alternatives"],
    additionalProperties: false,
  },
};

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
${
  context.previousMessages?.length
    ? `**Previous Messages in Thread**:
${context.previousMessages.map((m) => `- ${m}`).join("\n")}`
    : ""
}`;
  }

  return `You are a repository classifier for a coding agent. Your job is to determine which code repository a Microsoft Teams message is referring to.

## Available Repositories
${repoDescriptions}

${contextSection}

## User's Message
${message}

## Your Task

Analyze the message and context to determine which repository the user is referring to.

Consider:
1. Explicit mentions of repository names or aliases
2. Technical keywords that match repository technologies
3. File paths or code patterns mentioned
4. Channel associations (some channels are associated with specific repos)
5. Context from previous messages in the thread

## Response Format

Return your decision by calling the ${CLASSIFY_REPO_TOOL_NAME} tool with:
- repoId: "owner/name" or null if unclear
- confidence: "high" | "medium" | "low"
- reasoning: brief explanation
- alternatives: other possible repos when confidence is not high`;
}

interface LLMResponse {
  repoId: string | null;
  confidence: "high" | "medium" | "low";
  reasoning: string;
  alternatives: string[];
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

  return {
    repoId,
    confidence: confidence as ClassificationResult["confidence"],
    reasoning: input.reasoning.trim(),
    alternatives: [...new Set(alternatives)],
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

export class RepoClassifier {
  private client: Anthropic;
  private env: Env;

  constructor(env: Env) {
    this.env = env;
    this.client = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
    });
  }

  async classify(
    message: string,
    context?: ThreadContext,
    traceId?: string
  ): Promise<ClassificationResult> {
    const repos = await getAvailableRepos(this.env, traceId);

    if (repos.length === 0) {
      return {
        repo: null,
        confidence: "low",
        reasoning: "No repositories are currently available.",
        needsClarification: true,
      };
    }

    if (repos.length === 1) {
      return {
        repo: repos[0],
        confidence: "high",
        reasoning: "Only one repository is available.",
        needsClarification: false,
      };
    }

    if (context?.channelId) {
      const channelRepos = await getReposByChannel(this.env, context.channelId, traceId);
      if (channelRepos.length === 1) {
        return {
          repo: channelRepos[0],
          confidence: "high",
          reasoning: `Channel is associated with repository ${channelRepos[0].fullName}`,
          needsClarification: false,
        };
      }
    }

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
        messages: [{ role: "user", content: prompt }],
      });

      const llmResult = extractStructuredResponse(response);

      let matchedRepo: RepoConfig | null = null;
      if (llmResult.repoId) {
        matchedRepo =
          repos.find(
            (r) =>
              r.id.toLowerCase() === llmResult.repoId!.toLowerCase() ||
              r.fullName.toLowerCase() === llmResult.repoId!.toLowerCase()
          ) || null;
      }

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
        reasoning: "Could not classify repository. Please select a repository.",
        alternatives: repos.slice(0, 5),
        needsClarification: true,
      };
    }
  }
}

export function createClassifier(env: Env): RepoClassifier {
  return new RepoClassifier(env);
}
