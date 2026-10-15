import type { WebhookAutomationEvent } from "@open-inspect/shared/triggers";
import type { AutomationRow } from "../db/automation-store";
import { generateId, hashToken } from "../auth/crypto";
import { AUTOMATION_CONTEXT_GUARDRAIL, composeAutomationPrompt } from "./event-prompt";
import { evaluateEventConditions, type EventSourcePolicy } from "./event-policy";
import {
  continueSession,
  findHistoricalPromptReceipt,
  steeringActor,
  SessionFollowUpRefusedError,
  type SessionContinuityDeps,
  type ContinuationPolicy,
} from "./session-continuity";

/** A crashed follow-up request may be retried after this D1 ownership lease expires. */
const FOLLOW_UP_RECEIPT_CLAIM_MS = 2 * 60 * 1000;

interface WebhookFollowUpClaim {
  claimId: string;
  invocationId: string;
}

export async function createWebhookEventPolicy(
  event: WebhookAutomationEvent,
  deps: SessionContinuityDeps
): Promise<EventSourcePolicy> {
  const { store } = deps;
  const followUpKey =
    event.sessionKey && event.triggerKey.startsWith("webhook:idem:") ? event.triggerKey : null;
  const requestId = followUpKey ? `webhook:${await hashToken(followUpKey)}` : null;
  return {
    async candidates() {
      const automation = await store.getById(event.automationId);
      return automation && automation.enabled === 1 && !automation.deleted_at ? [automation] : [];
    },
    async dispatch(automation, now, fire) {
      let reservation: WebhookFollowUpClaim | null = null;
      const release = async (): Promise<void> => {
        if (reservation)
          await store.releaseFollowUpReceipt(automation.id, event.triggerKey, reservation.claimId);
      };
      if (followUpKey) {
        const original = await store.getInvocationIdByTriggerKey(automation.id, followUpKey);
        if (original) return { kind: "skipped", invocationId: original };
        const claimId = generateId();
        const invocationId = generateId();
        const claim = await store.claimFollowUpReceipt({
          automationId: automation.id,
          triggerKey: followUpKey,
          claimInvocationId: invocationId,
          claimId,
          now,
          expiresAt: now + FOLLOW_UP_RECEIPT_CLAIM_MS,
        });
        if (claim.kind === "accepted") return { kind: "skipped", invocationId: claim.invocationId };
        if (claim.kind === "pending")
          throw new SessionFollowUpRefusedError({
            kind: "refused",
            invocationId: claim.invocationId,
            status: null,
            code: null,
          });
        reservation = { claimId, invocationId };
        const historical = await findHistoricalPromptReceipt(
          deps,
          automation,
          event.concurrencyKey,
          requestId!
        );
        if (historical.kind === "refused") throw new SessionFollowUpRefusedError(historical);
        if (historical.kind === "skipped" && historical.invocationId) {
          await store.acceptFollowUpReceipt(
            automation.id,
            followUpKey,
            claimId,
            historical.invocationId,
            now
          );
          return historical;
        }
      }
      const conditions = evaluateEventConditions(automation, event, deps.log);
      if (conditions !== "matched") {
        await release();
        return conditions === "invalid" ? { kind: "skipped", invocationId: null } : null;
      }
      // Unlike Slack replies, a webhook continuation must satisfy the trigger conditions.
      if (event.sessionKey) {
        const continuation = await continueSession(
          deps,
          automation,
          event.concurrencyKey,
          now,
          await webhookContinuation(event, automation, reservation, requestId, deps)
        );
        if (continuation.kind === "refused") throw new SessionFollowUpRefusedError(continuation);
        if (continuation.kind !== "fall_through") return continuation;
      }
      const result = await fire({
        invocationId: reservation?.invocationId,
        webhookFollowUpClaimId: reservation?.claimId,
        instructionsOverride: composeAutomationPrompt(event.contextBlock, automation.instructions),
      });
      if (reservation) {
        if (result.outcome === "deduplicated" && result.invocationId) {
          await store.acceptFollowUpReceipt(
            automation.id,
            event.triggerKey,
            reservation.claimId,
            result.invocationId,
            Date.now()
          );
        } else if (result.outcome !== "started") {
          await release();
        }
      }
      return result;
    },
  };
}

/**
 * Continuity for a webhook delivery with a sessionKey: its context block becomes the
 * next turn of the session, sent as the automation's executor (whom the run acts as).
 * No callback context, so the run's own status is untouched.
 */
async function webhookContinuation(
  event: WebhookAutomationEvent,
  automation: AutomationRow,
  claim: WebhookFollowUpClaim | null,
  requestId: string | null,
  deps: SessionContinuityDeps
): Promise<ContinuationPolicy> {
  const { store } = deps;
  const clientRequestId = requestId ?? `webhook:${await hashToken(event.triggerKey)}`;
  return {
    source: "webhook",
    acceptDelivery: claim
      ? async (run) => {
          await store.acceptFollowUpReceipt(
            automation.id,
            event.triggerKey,
            claim.claimId,
            run.invocation_id,
            Date.now()
          );
        }
      : undefined,
    releaseDelivery: claim
      ? () => store.releaseFollowUpReceipt(automation.id, event.triggerKey, claim.claimId)
      : undefined,
    resolveActor: async () => {
      const owner = await store.resolveCanonicalOwner(automation);
      return owner.user_id
        ? steeringActor(
            deps.db,
            deps.backgroundJobs,
            { userId: owner.user_id, authorId: owner.created_by },
            `automation:webhook-steering:${event.triggerKey}`,
            event.triggerKey
          )
        : null;
    },
    buildPrompt: async (_run, actor) => ({
      body: {
        content: `${event.contextBlock}\n\n---\n\n${AUTOMATION_CONTEXT_GUARDRAIL}`,
        authorId: actor.authorId,
        canonicalUserId: actor.userId,
        source: "automation",
        // Hashed so the id fits clientRequestIdSchema's 128-character limit.
        clientRequestId,
      },
      ctx: { trace_id: `automation:${automation.id}`, request_id: event.triggerKey },
    }),
  };
}
