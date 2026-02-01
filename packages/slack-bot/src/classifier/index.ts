/**
 * Repository classifier for the Slack bot.
 *
 * Uses an LLM to classify which repository a Slack message refers to,
 * based on message content, thread context, and channel information.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Env, RepoConfig, ThreadContext, ClassificationResult } from "../types";
import { getAvailableRepos, buildRepoDescriptions, getReposByChannel } from "./repos";
import { createLogger } from "../logger";

const log = createLogger("classifier");

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

  return `You are a repository classifier for a coding agent. Your job is to determine which code repository a Slack message is referring to.

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

Respond with a JSON object (no markdown code blocks):
{
  "repoId": "owner/name" or null if unclear,
  "confidence": "high" | "medium" | "low",
  "reasoning": "Brief explanation of why you chose this repo",
  "alternatives": ["owner/name", ...] // Other possible repos if confidence is not high
}

If no repository matches or the message doesn't seem to be about code:
{
  "repoId": null,
  "confidence": "low",
  "reasoning": "Explanation of why no repo was identified",
  "alternatives": []
}`;
}

/**
 * Parse the LLM response into a structured result.
 */
interface LLMResponse {
  repoId: string | null;
  confidence: "high" | "medium" | "low";
  reasoning: string;
  alternatives?: string[];
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

    // If only one repo, skip classification
    if (repos.length === 1) {
      return {
        repo: repos[0],
        confidence: "high",
        reasoning: "Only one repository is available.",
        needsClarification: false,
      };
    }

    // Check for channel-specific repos first
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

    // Use LLM for classification
    try {
      const prompt = await buildClassificationPrompt(this.env, message, context, traceId);

      const response = await this.client.messages.create({
        model: this.env.CLASSIFICATION_MODEL || "claude-haiku-4-5",
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      });

      // Extract text from response
      const textContent = response.content.find((c) => c.type === "text");
      if (!textContent || textContent.type !== "text") {
        throw new Error("No text response from LLM");
      }

      // Parse JSON response
      const llmResult = JSON.parse(textContent.text) as LLMResponse;

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
      if (llmResult.alternatives) {
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

      // Fallback: try simple keyword matching
      return this.fallbackClassification(message, repos, context);
    }
  }

  /**
   * Fallback classification using simple keyword matching.
   */
  private fallbackClassification(
    message: string,
    repos: RepoConfig[],
    context?: ThreadContext
  ): ClassificationResult {
    const messageLower = message.toLowerCase();

    // Score each repo based on keyword matches
    const scored = repos.map((repo) => {
      let score = 0;

      // Check repo name
      if (messageLower.includes(repo.name.toLowerCase())) {
        score += 10;
      }

      // Check owner
      if (messageLower.includes(repo.owner.toLowerCase())) {
        score += 5;
      }

      // Check aliases
      for (const alias of repo.aliases || []) {
        if (messageLower.includes(alias.toLowerCase())) {
          score += 8;
        }
      }

      // Check keywords
      for (const keyword of repo.keywords || []) {
        if (messageLower.includes(keyword.toLowerCase())) {
          score += 3;
        }
      }

      // Check channel association
      if (context?.channelId && repo.channelAssociations?.includes(context.channelId)) {
        score += 15;
      }

      return { repo, score };
    });

    // Sort by score
    scored.sort((a, b) => b.score - a.score);

    const topMatch = scored[0];
    const hasMatch = topMatch && topMatch.score > 0;

    if (!hasMatch) {
      return {
        repo: null,
        confidence: "low",
        reasoning: "Could not determine repository from message content.",
        alternatives: repos.slice(0, 3),
        needsClarification: true,
      };
    }

    const confidence = topMatch.score >= 10 ? "high" : topMatch.score >= 5 ? "medium" : "low";

    return {
      repo: topMatch.repo,
      confidence,
      reasoning: `Matched based on keyword analysis (score: ${topMatch.score})`,
      alternatives: scored
        .slice(1, 4)
        .filter((s) => s.score > 0)
        .map((s) => s.repo),
      needsClarification: confidence !== "high",
    };
  }
}

/**
 * Create a new classifier instance.
 */
export function createClassifier(env: Env): RepoClassifier {
  return new RepoClassifier(env);
}
