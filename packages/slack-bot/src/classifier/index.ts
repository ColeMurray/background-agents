/**
 * Target classifier for the Slack bot.
 *
 * Uses an LLM to classify which target — a repository or a saved environment —
 * a Slack message refers to, based on message content, thread context, and
 * channel information.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  CLASSIFY_TARGET_TOOL_NAME,
  CLASSIFIER_MESSAGE_MAX_CHARS,
  TARGET_CLASSIFIER_SYSTEM_PROMPT,
  ANTHROPIC_CLASSIFICATION_MODEL_ID,
  targetClassificationRequestSchema,
  targetClassificationResponseSchema,
  classificationModelSchema,
  targetClassificationDecisionSchema,
  targetClassificationJsonSchema,
  buildTargetClassificationPrompt,
  type ClassificationModel,
  type TargetClassificationDecision,
  type TargetClassificationRequest,
} from "@open-inspect/shared/types/target-classification";
import type { Env, ThreadContext, ClassificationResult } from "../types";
import { loadTargetCatalog, type TargetCatalog } from "./catalog";
import { matchTargetId, resolveChannelTargets, resolveRoutingRuleTargets } from "./routing";
import { escapeMrkdwnText } from "@open-inspect/shared/slack";
import { targetId, targetLabel, targetValue, type SlackSessionTarget } from "../targets";
import { createLogger } from "../logger";
import { signedControlPlaneFetch } from "../internal-auth";

const log = createLogger("classifier");
const DEFAULT_CLASSIFICATION_MODEL: ClassificationModel = ANTHROPIC_CLASSIFICATION_MODEL_ID;
const ANTHROPIC_API_MODEL = "claude-haiku-4-5";
const TARGET_CLASSIFICATIONS_URL = "https://internal/internal/target-classifications";
const CLASSIFY_TARGET_INPUT_SCHEMA: Anthropic.Messages.Tool.InputSchema = {
  ...targetClassificationJsonSchema,
};

const CLASSIFY_TARGET_TOOL: Anthropic.Messages.Tool = {
  name: CLASSIFY_TARGET_TOOL_NAME,
  description:
    "Classify which repository or environment a Slack message refers to. " +
    "Use targetId as null when uncertain.",
  input_schema: CLASSIFY_TARGET_INPUT_SCHEMA,
};

class ClassificationMessageTooLongError extends Error {}

function createTargetClassificationRequest(
  message: string,
  catalog: TargetCatalog,
  context?: ThreadContext
): TargetClassificationRequest {
  const parsed = targetClassificationRequestSchema.safeParse({
    message,
    targets: [
      ...catalog.repos.map((repository) => ({
        kind: "repository" as const,
        id: repository.id,
        fullName: repository.fullName,
        description: repository.description,
        aliases: repository.aliases,
        keywords: repository.keywords,
        defaultBranch: repository.defaultBranch,
        private: repository.private,
      })),
      ...catalog.environments.map((environment) => ({
        kind: "environment" as const,
        id: environment.id,
        name: environment.name,
        description: environment.description,
        repositories: environment.repositories.map(
          (repository) => `${repository.repoOwner}/${repository.repoName}`
        ),
      })),
    ],
    context: context
      ? {
          channelId: context.channelId,
          channelName: context.channelName,
          channelDescription: context.channelDescription,
          inThread: Boolean(context.threadTs),
          previousMessages: context.previousMessages,
        }
      : undefined,
  });
  if (!parsed.success) {
    if (message.length > CLASSIFIER_MESSAGE_MAX_CHARS) {
      throw new ClassificationMessageTooLongError();
    }
    throw new Error("Invalid target classification input");
  }
  return parsed.data;
}

/**
 * Parse the LLM response into a structured result.
 */
function resolveClassificationModel(value: unknown): ClassificationModel | null {
  const raw = (typeof value === "string" ? value.trim() : "") || DEFAULT_CLASSIFICATION_MODEL;
  const parsed = classificationModelSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAnthropicToolInput(raw: unknown): TargetClassificationDecision {
  if (!isRecord(raw)) {
    throw new Error("LLM response was not an object");
  }

  const rawTargetId = raw.targetId;
  const targetId =
    typeof rawTargetId === "string" && rawTargetId.trim().length > 0 ? rawTargetId.trim() : null;
  const normalized = targetClassificationDecisionSchema.safeParse({
    targetId,
    confidence:
      typeof raw.confidence === "string" ? raw.confidence.trim().toLowerCase() : raw.confidence,
    reasoning: raw.reasoning,
    alternatives: raw.alternatives,
  });
  if (!normalized.success) {
    throw new Error("Invalid structured tool input in LLM response");
  }

  return {
    ...normalized.data,
    alternatives: [...new Set(normalized.data.alternatives)],
  };
}

function extractStructuredResponse(
  response: Anthropic.Messages.Message
): TargetClassificationDecision {
  const toolUseBlock = response.content.find(
    (block): block is Anthropic.Messages.ToolUseBlock =>
      block.type === "tool_use" && block.name === CLASSIFY_TARGET_TOOL_NAME
  );

  if (!toolUseBlock) {
    throw new Error("No structured tool_use classification in LLM response");
  }

  return normalizeAnthropicToolInput(toolUseBlock.input);
}

/**
 * Repository classifier class.
 */
export class RepoClassifier {
  private client: Anthropic | undefined;
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  private getAnthropicClient(): Anthropic {
    if (!this.client) {
      if (!this.env.ANTHROPIC_API_KEY) {
        throw new Error("Anthropic classifier API key is not configured");
      }
      this.client = new Anthropic({
        apiKey: this.env.ANTHROPIC_API_KEY,
      });
    }
    return this.client;
  }

  private async classifyWithAnthropic(
    request: TargetClassificationRequest
  ): Promise<TargetClassificationDecision> {
    const response = await this.getAnthropicClient().messages.create({
      model: ANTHROPIC_API_MODEL,
      max_tokens: 500,
      temperature: 0,
      system: TARGET_CLASSIFIER_SYSTEM_PROMPT,
      tools: [CLASSIFY_TARGET_TOOL],
      tool_choice: {
        type: "tool",
        name: CLASSIFY_TARGET_TOOL_NAME,
        disable_parallel_tool_use: true,
      },
      messages: [
        {
          role: "user",
          content: buildTargetClassificationPrompt(request),
        },
      ],
    });

    return extractStructuredResponse(response);
  }

  private async classifyWithControlPlane(
    request: TargetClassificationRequest,
    traceId?: string
  ): Promise<TargetClassificationDecision> {
    const body = JSON.stringify(request);
    const response = await signedControlPlaneFetch(
      this.env,
      {
        method: "POST",
        url: TARGET_CLASSIFICATIONS_URL,
        body,
        traceId,
      },
      { headers: { Accept: "application/json" } }
    );

    if (!response.ok) {
      throw new Error(`Target classification request failed with ${response.status}`);
    }

    const parsed = targetClassificationResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error("Invalid target classification response");
    }
    return parsed.data;
  }

  private async classifyWithModel(
    model: ClassificationModel,
    request: TargetClassificationRequest,
    traceId?: string
  ): Promise<TargetClassificationDecision> {
    if (model === ANTHROPIC_CLASSIFICATION_MODEL_ID) {
      return this.classifyWithAnthropic(request);
    }
    return this.classifyWithControlPlane(request, traceId);
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
    const catalog = await loadTargetCatalog(this.env, traceId);

    // Only a fully empty catalog is unclassifiable — environments launch by id
    // without consulting the repo list, so they stay reachable when the repo
    // fetch degrades to [].
    if (catalog.repos.length === 0 && catalog.environments.length === 0) {
      return {
        target: null,
        confidence: "low",
        reasoning: "No repositories or environments are currently available.",
        needsClarification: true,
      };
    }

    // Deterministic routing rules (explicit keyword → repo or environment) take
    // precedence over everything below — including the single-repo shortcut,
    // which would otherwise make environment-targeted rules unreachable in
    // one-repo workspaces — but never override an active thread (handled before
    // classify is called).
    const routed = await this.classifyByRoutingRules(message, catalog, traceId);
    if (routed) {
      return routed;
    }

    // Channel associations are the second deterministic stage. Like routing
    // rules, they run before the single-repo shortcut so a channel associated
    // with an environment stays reachable in one-repo workspaces.
    const channelRouted = context?.channelId
      ? this.classifyByChannelAssociations(context.channelId, catalog, traceId)
      : null;
    if (channelRouted) {
      return channelRouted;
    }

    // With a single repository and no environments there is nothing to choose.
    if (catalog.repos.length === 1 && catalog.environments.length === 0) {
      return {
        target: { kind: "repository", repo: catalog.repos[0] },
        confidence: "high",
        reasoning: "Only one repository is available.",
        needsClarification: false,
      };
    }

    // Use LLM for classification
    try {
      const request = createTargetClassificationRequest(message, catalog, context);
      const model = resolveClassificationModel(this.env.CLASSIFICATION_MODEL);
      if (!model) {
        throw new Error(`Unsupported classifier model: ${this.env.CLASSIFICATION_MODEL}`);
      }
      const llmResult = await this.classifyWithModel(model, request, traceId);

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
          e instanceof ClassificationMessageTooLongError
            ? "This Slack message is too long to classify. Please shorten it and try again."
            : "Could not classify a target from structured model output. Please pick one below.",
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
