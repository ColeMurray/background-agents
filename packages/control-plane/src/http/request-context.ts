import type { EffectiveAuthorization } from "@open-inspect/shared/rbac";
import type { AuthenticationContext, Principal } from "../auth/principal";
import type { AuthenticationRequestServices } from "../auth/request-services";
import type { UserAuthRuntime } from "../auth/user/runtime";
import type { AutomationRow } from "../db/automation-store";
import type { RequestMetrics } from "../db/instrumented-d1";
import type { BackgroundTasks } from "../platform-ports";

/** Automation resource admitted for the current mutation. */
export interface AutomationRouteAdmission {
  automation: AutomationRow;
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
};
