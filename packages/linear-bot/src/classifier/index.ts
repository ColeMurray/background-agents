/**
 * Repository classifier for the Linear bot.
 * Uses Bedrock InvokeModel API with Anthropic Messages format to classify which repo an issue belongs to.
 */

import type { Env, RepoConfig, ClassificationResult } from "../types";
import type { ConfidenceLevel } from "@open-inspect/shared";
import { getAvailableRepos, buildRepoDescriptions } from "./repos";
import { createLogger } from "../logger";

const log = createLogger("classifier");

const CLASSIFY_REPO_TOOL_NAME = "classify_repository";

interface ClassifyToolInput {
  repoId: string | null;
  confidence: ConfidenceLevel;
  reasoning: string;
  alternatives: string[];
}

interface BedrockContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
}

interface BedrockResponse {
  content: BedrockContentBlock[];
}

/**
 * Build classification prompt from Linear issue context.
 */
async function buildClassificationPrompt(
  env: Env,
  issueTitle: string,
  issueDescription: string | null | undefined,
  labels: string[],
  projectName: string | null | undefined,
  traceId?: string
): Promise<string> {
  const repoDescriptions = await buildRepoDescriptions(env, traceId);

  let contextSection = "";
  if (labels.length > 0) contextSection += `\n**Labels**: ${labels.join(", ")}`;
  if (projectName) contextSection += `\n**Project**: ${projectName}`;

  return `You are a repository classifier for a coding agent. Your job is to determine which code repository a Linear issue belongs to.

## Available Repositories
${repoDescriptions}

## Issue
**Title**: ${issueTitle}
${issueDescription ? `**Description**: ${issueDescription}` : ""}
${contextSection}

## Your Task

Analyze the issue to determine which repository it belongs to.

Consider:
1. Explicit mentions of repository names or aliases
2. Technical keywords that match repository technologies
3. File paths or code patterns mentioned
4. Project name associations
5. Label associations

Return your decision by calling the ${CLASSIFY_REPO_TOOL_NAME} tool.`;
}

const BEDROCK_CLASSIFICATION_MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

/**
 * Call Bedrock InvokeModel API with Anthropic Messages format.
 */
async function callBedrock(
  bearerToken: string,
  region: string,
  prompt: string
): Promise<ClassifyToolInput> {
  const modelId = BEDROCK_CLASSIFICATION_MODEL;
  const response = await fetch(
    `https://bedrock-runtime.${region}.amazonaws.com/model/${modelId}/invoke`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 500,
        temperature: 0,
        tools: [
          {
            name: CLASSIFY_REPO_TOOL_NAME,
            description: "Classify which repository an issue belongs to.",
            input_schema: {
              type: "object" as const,
              properties: {
                repoId: {
                  type: ["string", "null"],
                  description: "Repository ID (owner/name) if confident, otherwise null.",
                },
                confidence: {
                  type: "string",
                  enum: ["high", "medium", "low"],
                },
                reasoning: {
                  type: "string",
                  description: "Brief explanation.",
                },
                alternatives: {
                  type: "array",
                  items: { type: "string" },
                  description: "Alternative repo IDs when not confident.",
                },
              },
              required: ["repoId", "confidence", "reasoning", "alternatives"],
            },
          },
        ],
        tool_choice: { type: "tool", name: CLASSIFY_REPO_TOOL_NAME },
        messages: [{ role: "user", content: prompt }],
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Bedrock API error ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as BedrockResponse;
  const toolBlock = data.content.find(
    (b) => b.type === "tool_use" && b.name === CLASSIFY_REPO_TOOL_NAME
  );

  if (!toolBlock) throw new Error("No tool_use block in Bedrock response");

  const input = toolBlock.input as Record<string, unknown>;
  return {
    repoId: input.repoId === null ? null : typeof input.repoId === "string" ? input.repoId : null,
    confidence: (input.confidence as ConfidenceLevel) || "low",
    reasoning: String(input.reasoning || ""),
    alternatives: Array.isArray(input.alternatives)
      ? input.alternatives.filter((a): a is string => typeof a === "string")
      : [],
  };
}

/**
 * Classify which repository a Linear issue belongs to.
 */
export async function classifyRepo(
  env: Env,
  issueTitle: string,
  issueDescription: string | null | undefined,
  labels: string[],
  projectName: string | null | undefined,
  traceId?: string
): Promise<ClassificationResult> {
  const repos = await getAvailableRepos(env, traceId);

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

  try {
    const prompt = await buildClassificationPrompt(
      env,
      issueTitle,
      issueDescription,
      labels,
      projectName,
      traceId
    );

    const result = await callBedrock(env.AWS_BEARER_TOKEN_BEDROCK, env.AWS_REGION, prompt);

    let matchedRepo: RepoConfig | null = null;
    if (result.repoId) {
      matchedRepo =
        repos.find(
          (r) =>
            r.id.toLowerCase() === result.repoId!.toLowerCase() ||
            r.fullName.toLowerCase() === result.repoId!.toLowerCase()
        ) || null;
    }

    const alternatives: RepoConfig[] = [];
    for (const altId of result.alternatives) {
      const alt = repos.find(
        (r) =>
          r.id.toLowerCase() === altId.toLowerCase() ||
          r.fullName.toLowerCase() === altId.toLowerCase()
      );
      if (alt && alt.id !== matchedRepo?.id) alternatives.push(alt);
    }

    return {
      repo: matchedRepo,
      confidence: result.confidence,
      reasoning: result.reasoning,
      alternatives: alternatives.length > 0 ? alternatives : undefined,
      needsClarification:
        !matchedRepo ||
        result.confidence === "low" ||
        (result.confidence === "medium" && alternatives.length > 0),
    };
  } catch (e) {
    log.error("classifier.classify", {
      trace_id: traceId,
      outcome: "error",
      error: e instanceof Error ? e : new Error(String(e)),
    });

    return {
      repo: null,
      confidence: "low",
      reasoning: "Could not classify repository. Please configure project→repo mapping.",
      alternatives: repos.slice(0, 5),
      needsClarification: true,
    };
  }
}
