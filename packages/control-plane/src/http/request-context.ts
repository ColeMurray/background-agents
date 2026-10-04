import type { EffectiveAuthorization } from "@open-inspect/shared/rbac";
import type { TeamCapabilities } from "@open-inspect/shared/types/team-access";
import type { Team } from "@open-inspect/shared/types/teams";
import type { TeamRole } from "@open-inspect/shared/types/teams";
import type { SessionAccessRow, SessionViewer } from "@open-inspect/shared";
import type { AuthenticationContext, Principal } from "../auth/principal";
import type { AuthenticationRequestServices } from "../auth/request-services";
import type { UserAuthRuntime } from "../auth/user/runtime";
import type { AutomationRow } from "../db/automation-store";
import type { EnvironmentAdmission } from "../authorization/owned-resource-admission";
import type { SessionEntry } from "../db/session-index";
import type { RequestMetrics } from "../db/instrumented-sql-database";
import type { BackgroundTasks } from "../platform-ports";
import type { TeamsEnforcementMode } from "../authorization/teams-enforcement";

/** Automation resource admitted for the current mutation. */
export interface AutomationRouteAdmission {
  automation: AutomationRow;
  viewer: SessionViewer;
}

/**
 * Framework-neutral aggregate state assembled at the HTTP composition root.
 * Authentication consumes only its narrower AuthenticationRequestServices
 * projection, preventing auth from depending on route or Hono contracts.
 */
export type RequestContext = AuthenticationRequestServices & {
  metrics: RequestMetrics;
  executionCtx: BackgroundTasks;
  getUserAuthRuntime?: () => UserAuthRuntime;
  principal?: Principal;
  authentication?: AuthenticationContext;
  authorization?: EffectiveAuthorization;
  automationAdmission?: AutomationRouteAdmission;
  /** Written only by route admission; read via `admittedEnvironment`. */
  environmentAdmission?: EnvironmentAdmission;
  teamAdmission?: { team: Team; access: TeamCapabilities };
  sessionAdmission?: { row: SessionEntry & SessionAccessRow; viewer: SessionViewer };
  childSessionAdmission?: { row: SessionEntry & SessionAccessRow; viewer: SessionViewer };
  sessionMemberships?: ReadonlyMap<string, TeamRole>;
  /** Undefined means no coordinate; null means a supplied coordinate is unbound. */
  serviceTeamId?: string | null;
  serviceReadPurpose?: "slack-post";
  teamsEnforcementMode?: TeamsEnforcementMode;
  shadowSessionDenial?: string;
  /** Per-session evidence for explicit body-ID action batches, not collection reads. */
  shadowBatchDenials?: { sessionId: string; reason: string }[];
  shadowListDenialCount?: number;
};
