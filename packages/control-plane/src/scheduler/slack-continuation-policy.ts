import type { SlackAutomationEvent } from "@open-inspect/shared/triggers";
import type { SlackCallbackContext } from "@open-inspect/shared/types/session-api";
import type { AutomationRow, AutomationRunRow } from "../db/automation-store";
import type { UserStore } from "../db/user-store";
import type { SourceControlProviderName } from "../source-control/types";
import type { AutomationAttributionService } from "./attribution-service";
import type { ContinuationPolicy, SteeringActor } from "./session-continuity";
import type { SessionContinuityService } from "./session-continuity-service";
import { formatRunRepositoryLabel } from "./slack-completion";

interface SlackContinuationPolicyDeps {
  users: Pick<UserStore, "getIdentity">;
  continuity: Pick<SessionContinuityService, "resolveActor">;
  attribution: Pick<AutomationAttributionService, "resolve">;
  scmProvider: SourceControlProviderName;
}

/** Create a fresh actor cache for each delivery, shared by all its matching automations. */
export class SlackContinuationPolicyFactory {
  constructor(private readonly deps: SlackContinuationPolicyDeps) {}

  create(event: SlackAutomationEvent): ContinuationPolicy {
    return new SlackContinuationPolicy(this.deps, event);
  }
}

/** Turn a thread reply into a session prompt with its own Slack completion callback. */
export class SlackContinuationPolicy implements ContinuationPolicy {
  readonly source = "slack";
  readonly logFields: Record<string, unknown>;
  private actorPromise: Promise<SteeringActor | null> | undefined;

  constructor(
    private readonly deps: SlackContinuationPolicyDeps,
    private readonly event: SlackAutomationEvent
  ) {
    this.logFields = { slack_actor_id: event.actorUserId, channel: event.channelId };
  }

  resolveActor(): Promise<SteeringActor | null> {
    return (this.actorPromise ??= this.lookupActor());
  }

  private async lookupActor(): Promise<SteeringActor | null> {
    const { event, deps } = this;
    const identity = await deps.users.getIdentity("slack", event.actorUserId);
    if (!identity) return null;
    return deps.continuity.resolveActor(
      { userId: identity.userId, authorId: `slack:${event.actorUserId}` },
      `automation:slack-steering:${event.triggerKey}`,
      event.triggerKey
    );
  }

  async buildPrompt(
    run: AutomationRunRow,
    actor: SteeringActor,
    automation: AutomationRow
  ): ReturnType<ContinuationPolicy["buildPrompt"]> {
    const { event, deps } = this;
    const callbackContext: SlackCallbackContext = {
      source: "slack",
      channel: event.channelId,
      // Post in the existing thread; for a reply, threadTs is the thread root.
      threadTs: event.threadTs ?? event.ts,
      // React on (and later clear) the follow-up message itself.
      reactionMessageTs: event.ts,
      repoFullName: formatRunRepositoryLabel(run),
      model: automation.model,
      reasoningEffort: automation.reasoning_effort ?? undefined,
      // The interactive callback must treat this turn as automation-owned.
      automationId: automation.id,
    };
    const enrichment = await deps.attribution.resolve(actor.userId);
    return {
      body: {
        content: event.text,
        authorId: actor.authorId,
        canonicalUserId: actor.userId,
        scmEnrichment:
          deps.scmProvider === "github"
            ? {
                userId: enrichment?.scmUserId ?? null,
                login: enrichment?.scmLogin ?? null,
                name: enrichment?.displayName ?? null,
                email: enrichment?.email ?? null,
              }
            : undefined,
        source: "slack",
        callbackContext,
      },
      // Each inbound message is its own hop, even when the run takes many follow-ups.
      ctx: {
        trace_id: `automation:${automation.id}`,
        request_id: `slack:${event.channelId}:${event.ts}`,
      },
    };
  }
}
