import type { Logger } from "../../../logger";
import { parseArtifactMetadata } from "../../artifact-metadata";
import type { MessageRepository } from "../../message-repository";
import type { ArtifactRepository } from "../../artifact-repository";
import type { EventRepository } from "../../event-repository";
import type { SessionCoreRepository } from "../../session-core-repository";
import type { SandboxRepository } from "../../sandbox-repository";
import { resolvePublicSessionId } from "../../public-session-id";
import {
  RECENT_EVENT_FETCH_LIMIT,
  buildChildSessionDetail,
  collectFinalResponseEventRows,
  parseChildSummaryOptions,
  type ChildSummaryFinalResponseInput,
  type ChildSummaryTrajectoryInput,
} from "./child-session-summary";

/**
 * HTTP boundary for `/internal/child-summary` — the read model a parent agent
 * fetches about this child session: status, artifacts, recent activity, and
 * on request the final response and a paginated trajectory. This class only
 * gathers rows; the assembly lives in the pure builders in
 * `child-session-summary.ts`.
 */
export class ChildSummaryHandler {
  constructor(
    private readonly sessionCoreRepository: SessionCoreRepository,
    private readonly sandboxRepository: SandboxRepository,
    private readonly messageRepository: MessageRepository,
    private readonly eventRepository: EventRepository,
    private readonly artifactRepository: ArtifactRepository,
    private readonly durableObjectId: string,
    private readonly log: Logger
  ) {}

  getChildSummary(url?: URL): Response {
    const session = this.sessionCoreRepository.getSession();
    if (!session) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    const parsedOptions = parseChildSummaryOptions(url);
    if (!parsedOptions.ok) {
      return Response.json({ error: parsedOptions.error }, { status: 400 });
    }

    const options = parsedOptions.options;
    const sandbox = this.sandboxRepository.getSandbox();
    const artifacts = this.artifactRepository.listArtifacts();
    const recentEventRows = this.eventRepository.listEventPage({
      limit: RECENT_EVENT_FETCH_LIMIT,
    }).events;
    let finalResponse: ChildSummaryFinalResponseInput | undefined;
    let trajectory: ChildSummaryTrajectoryInput | undefined;

    if (options.includeFinalResponse) {
      const terminalMessage = this.messageRepository.getLatestTerminalMessage();
      const collectedEvents = terminalMessage
        ? collectFinalResponseEventRows(this.eventRepository, terminalMessage.id)
        : { eventRows: [], eventLimitReached: false };
      finalResponse = { message: terminalMessage, ...collectedEvents };
    }

    if (options.includeTrajectory) {
      const page = this.eventRepository.getEventTimelinePage({
        limit: options.trajectoryLimit,
        cursor: options.trajectoryCursor ?? undefined,
      });
      trajectory = {
        eventRows: page.events,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
        limit: options.trajectoryLimit,
      };
    }

    return Response.json(
      buildChildSessionDetail({
        session,
        sandbox,
        publicSessionId: resolvePublicSessionId(session, this.durableObjectId),
        artifacts,
        recentEventRows,
        hasUnfinishedPrompt: this.messageRepository.getPendingOrProcessingCount() > 0,
        parseArtifactMetadata: (artifact) => parseArtifactMetadata(artifact, this.log),
        finalResponse,
        trajectory,
      })
    );
  }
}
