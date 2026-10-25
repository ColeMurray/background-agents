import type { WebhookAutomationEvent } from "@open-inspect/shared/triggers";
import type * as Crypto from "../auth/crypto";
import type { AutomationRow, AutomationRunRow, AutomationStore } from "../db/automation-store";
import { AUTOMATION_CONTEXT_GUARDRAIL } from "./event-prompt";
import type { ContinuationPolicy, SteeringActor } from "./session-continuity";
import type { SessionContinuityService } from "./session-continuity-service";

export interface WebhookFollowUpClaim {
  claimId: string;
  invocationId: string;
}

interface WebhookContinuationPolicyDeps {
  store: Pick<
    AutomationStore,
    "resolveCanonicalOwner" | "acceptFollowUpReceipt" | "releaseFollowUpReceipt"
  >;
  continuity: Pick<SessionContinuityService, "resolveActor">;
  clock: Pick<DateConstructor, "now">;
}

/** Bind the delivery's receipt claim and stable prompt ID before attempting continuation. */
export class WebhookContinuationPolicyFactory {
  constructor(
    private readonly deps: WebhookContinuationPolicyDeps & {
      crypto: Pick<typeof Crypto, "hashToken">;
    }
  ) {}

  async create(
    event: WebhookAutomationEvent,
    automation: AutomationRow,
    claim: WebhookFollowUpClaim | null,
    requestId: string | null
  ): Promise<ContinuationPolicy> {
    // Hashed so the ID fits clientRequestIdSchema's 128-character limit.
    const clientRequestId =
      requestId ?? `webhook:${await this.deps.crypto.hashToken(event.triggerKey)}`;
    return new WebhookContinuationPolicy(this.deps, event, automation, claim, clientRequestId);
  }
}

/** Continue as the automation's executor, settling its receipt only when delivery is certain. */
export class WebhookContinuationPolicy implements ContinuationPolicy {
  readonly source = "webhook";

  constructor(
    private readonly deps: WebhookContinuationPolicyDeps,
    private readonly event: WebhookAutomationEvent,
    private readonly automation: AutomationRow,
    private readonly claim: WebhookFollowUpClaim | null,
    private readonly clientRequestId: string
  ) {}

  async acceptDelivery(run: AutomationRunRow): Promise<void> {
    if (!this.claim) return;
    await this.deps.store.acceptFollowUpReceipt(
      this.automation.id,
      this.event.triggerKey,
      this.claim.claimId,
      run.invocation_id,
      this.deps.clock.now()
    );
  }

  async releaseDelivery(): Promise<void> {
    if (!this.claim) return;
    await this.deps.store.releaseFollowUpReceipt(
      this.automation.id,
      this.event.triggerKey,
      this.claim.claimId
    );
  }

  async resolveActor(): Promise<SteeringActor | null> {
    const owner = await this.deps.store.resolveCanonicalOwner(this.automation);
    return owner.user_id
      ? this.deps.continuity.resolveActor(
          { userId: owner.user_id, authorId: owner.created_by },
          `automation:webhook-steering:${this.event.triggerKey}`,
          this.event.triggerKey
        )
      : null;
  }

  async buildPrompt(
    _run: AutomationRunRow,
    actor: SteeringActor
  ): ReturnType<ContinuationPolicy["buildPrompt"]> {
    return {
      body: {
        content: `${this.event.contextBlock}\n\n---\n\n${AUTOMATION_CONTEXT_GUARDRAIL}`,
        authorId: actor.authorId,
        canonicalUserId: actor.userId,
        source: "automation",
        clientRequestId: this.clientRequestId,
      },
      ctx: { trace_id: `automation:${this.automation.id}`, request_id: this.event.triggerKey },
    };
  }
}
