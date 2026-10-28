import {
  matchesConditions,
  conditionRegistry,
  type WebhookAutomationEvent,
  type TriggerConfig,
} from "@open-inspect/shared/triggers";
import { parseAutomationTriggerFields, type AutomationStore } from "../db/automation-store";
import type * as Crypto from "../auth/crypto";
import type { SessionContinuityService } from "./session-continuity-service";
import type { Logger } from "../logger";
import { SessionFollowUpRefusedError, type SchedulerEventResult } from "./contracts";
import type { AutomationInvocationService } from "./invocation-service";
import type {
  WebhookContinuationPolicyFactory,
  WebhookFollowUpClaim,
} from "./webhook-continuation-policy";
import { composeAutomationPrompt } from "./event-prompt";
import { recordEventLaunch, recordContinuation, logEventResult } from "./event-outcome";

/** A crashed follow-up request may be retried after this D1 ownership lease expires. */
const FOLLOW_UP_RECEIPT_CLAIM_MS = 2 * 60 * 1000;

export interface WebhookEventHandlerDeps {
  store: Pick<
    AutomationStore,
    | "getById"
    | "getInvocationIdByTriggerKey"
    | "claimFollowUpReceipt"
    | "acceptFollowUpReceipt"
    | "releaseFollowUpReceipt"
  >;
  invocations: Pick<AutomationInvocationService, "start">;
  continuity: Pick<SessionContinuityService, "continueSession" | "findHistoricalPromptReceipt">;
  policies: Pick<WebhookContinuationPolicyFactory, "create">;
  crypto: Pick<typeof Crypto, "hashToken" | "generateId">;
  clock: Pick<DateConstructor, "now">;
  log: Logger;
}

/** Own the delivery receipt until continuation or invocation admission accepts it. */
export class WebhookEventHandler {
  constructor(private readonly deps: WebhookEventHandlerDeps) {}

  async handle(event: WebhookAutomationEvent): Promise<SchedulerEventResult> {
    const deps = this.deps;
    const { store } = deps;
    const automation = await store.getById(event.automationId);
    const candidates =
      automation && automation.enabled === 1 && !automation.deleted_at ? [automation] : [];
    const summary: SchedulerEventResult = {
      triggered: 0,
      skipped: 0,
      steered: 0,
      invocationIds: [],
    };
    const webhookFollowUpTriggerKey =
      event.sessionKey && event.triggerKey.startsWith("webhook:idem:") ? event.triggerKey : null;
    const webhookFollowUpRequestId = webhookFollowUpTriggerKey
      ? `webhook:${await deps.crypto.hashToken(webhookFollowUpTriggerKey)}`
      : null;
    for (const automation of candidates) {
      const now = deps.clock.now();
      let webhookClaim: WebhookFollowUpClaim | null = null;
      const releaseWebhookClaim = async (): Promise<void> => {
        if (webhookClaim) {
          await store.releaseFollowUpReceipt(automation.id, event.triggerKey, webhookClaim.claimId);
        }
      };

      if (webhookFollowUpTriggerKey) {
        const original = await store.getInvocationIdByTriggerKey(
          automation.id,
          webhookFollowUpTriggerKey
        );
        if (original) {
          summary.invocationIds.push(original);
          summary.skipped++;
          continue;
        }

        const claimId = deps.crypto.generateId();
        const invocationId = deps.crypto.generateId();
        const claim = await store.claimFollowUpReceipt({
          automationId: automation.id,
          triggerKey: webhookFollowUpTriggerKey,
          claimInvocationId: invocationId,
          claimId,
          now,
          expiresAt: now + FOLLOW_UP_RECEIPT_CLAIM_MS,
        });
        if (claim.kind === "accepted") {
          summary.invocationIds.push(claim.invocationId);
          summary.skipped++;
          continue;
        }
        if (claim.kind === "pending") {
          throw new SessionFollowUpRefusedError({
            kind: "refused",
            invocationId: claim.invocationId,
            status: null,
            code: null,
          });
        }
        webhookClaim = { claimId, invocationId };

        const historical = await deps.continuity.findHistoricalPromptReceipt(
          automation,
          event.concurrencyKey,
          webhookFollowUpRequestId!
        );
        if (historical.kind === "refused") throw new SessionFollowUpRefusedError(historical);
        if (historical.kind === "skipped" && historical.invocationId) {
          await store.acceptFollowUpReceipt(
            automation.id,
            webhookFollowUpTriggerKey,
            claimId,
            historical.invocationId,
            now
          );
          recordContinuation(summary, historical);
          continue;
        }
      }

      // Trigger conditions gate starting a NEW run.
      let config: TriggerConfig;
      try {
        config = parseAutomationTriggerFields(automation).triggerConfig ?? { conditions: [] };
      } catch {
        await releaseWebhookClaim();
        deps.log.error("Skipped automation with invalid stored trigger fields", {
          event: "scheduler.invalid_trigger_fields",
          automation_id: automation.id,
        });
        summary.skipped++;
        continue;
      }
      if (!matchesConditions(config.conditions, event, conditionRegistry)) {
        await releaseWebhookClaim();
        continue;
      }

      if (event.sessionKey) {
        const outcome = await deps.continuity.continueSession(
          automation,
          event.concurrencyKey,
          now,
          await deps.policies.create(event, automation, webhookClaim, webhookFollowUpRequestId)
        );
        if (outcome.kind === "refused") throw new SessionFollowUpRefusedError(outcome);
        if (outcome.kind !== "fall_through") {
          recordContinuation(summary, outcome);
          continue;
        }
      }

      const result = await deps.invocations.start({
        automation,
        source: "event",
        actorKind: "unknown",
        invocationId: webhookClaim?.invocationId,
        webhookFollowUpClaimId: webhookClaim?.claimId,
        triggerKey: event.triggerKey,
        concurrencyKey: event.concurrencyKey,
        triggerMetadata: null,
        instructionsOverride: composeAutomationPrompt(event.contextBlock, automation.instructions),
      });
      if (webhookClaim) {
        if (result.outcome === "deduplicated" && result.invocationId) {
          await store.acceptFollowUpReceipt(
            automation.id,
            event.triggerKey,
            webhookClaim.claimId,
            result.invocationId,
            deps.clock.now()
          );
        } else if (result.outcome !== "started") {
          await releaseWebhookClaim();
        }
      }

      recordEventLaunch(summary, result, automation, event, deps.log);
    }
    logEventResult(deps.log, event, summary, candidates.length);
    return summary;
  }
}
