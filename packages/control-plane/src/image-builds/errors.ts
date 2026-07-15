/**
 * Image-build error taxonomy. Route handlers map codes to HTTP statuses;
 * workflow and planner throw these instead of returning Responses.
 */

import type { ImageBuildScopeKind } from "@open-inspect/shared";

export type ImageBuildErrorCode =
  | "scope_not_found"
  | "planning_failed"
  | "workflow_unavailable"
  | "provider_unconfigured"
  | "trigger_failed"
  | "invalid_callback"
  | "callback_auth_rejected"
  | "callback_auth_unavailable"
  | "completion_not_accepted"
  | "failure_not_accepted"
  | "build_complete_failed"
  | "build_failed_update_failed";

export abstract class ImageBuildError extends Error {
  abstract readonly code: ImageBuildErrorCode;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

export class ImageBuildScopeNotFoundError extends ImageBuildError {
  readonly code = "scope_not_found";

  constructor(kind: ImageBuildScopeKind, id: string) {
    super(kind === "environment" ? `Environment not found: ${id}` : `Repository not found: ${id}`);
  }
}

export class ImageBuildPlanningError extends ImageBuildError {
  readonly code = "planning_failed";
}

export class ImageBuildWorkflowUnavailableError extends ImageBuildError {
  readonly code = "workflow_unavailable";
}

export class ImageBuildProviderUnconfiguredError extends ImageBuildError {
  readonly code = "provider_unconfigured";
}

export class ImageBuildTriggerFailedError extends ImageBuildError {
  readonly code = "trigger_failed";

  constructor(message = "Failed to trigger build", cause?: unknown) {
    super(message, cause);
  }
}

export class ImageBuildInvalidCallbackError extends ImageBuildError {
  readonly code = "invalid_callback";
}

export class ImageBuildCallbackAuthRejectedError extends ImageBuildError {
  readonly code = "callback_auth_rejected";
}

export class ImageBuildCallbackAuthUnavailableError extends ImageBuildError {
  readonly code = "callback_auth_unavailable";
}

export class ImageBuildCompletionNotAcceptedError extends ImageBuildError {
  readonly code = "completion_not_accepted";
}

export class ImageBuildFailureNotAcceptedError extends ImageBuildError {
  readonly code = "failure_not_accepted";
}

export class ImageBuildCompleteFailedError extends ImageBuildError {
  readonly code = "build_complete_failed";

  constructor(message = "Failed to mark build as ready", cause?: unknown) {
    super(message, cause);
  }
}

export class ImageBuildFailedUpdateError extends ImageBuildError {
  readonly code = "build_failed_update_failed";

  constructor(message = "Failed to mark build as failed", cause?: unknown) {
    super(message, cause);
  }
}
