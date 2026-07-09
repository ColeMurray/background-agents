/**
 * Environment image build errors — mirrors the repo-image taxonomy
 * (repo-images/errors.ts) with the environment-specific 404 in place of
 * repository_not_installed. Kept parallel rather than shared so this PR does
 * not reshape the merged repo-images module; folding both into one image-build
 * taxonomy belongs to the tracked build-subsystem unification refactor.
 */

export type EnvironmentImageErrorCode =
  | "environment_not_found"
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

export abstract class EnvironmentImageError extends Error {
  abstract readonly code: EnvironmentImageErrorCode;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

export class EnvironmentImageEnvironmentNotFoundError extends EnvironmentImageError {
  readonly code = "environment_not_found";

  constructor(environmentId: string) {
    super(`Environment not found: ${environmentId}`);
  }
}

export class EnvironmentImagePlanningError extends EnvironmentImageError {
  readonly code = "planning_failed";
}

export class EnvironmentImageWorkflowUnavailableError extends EnvironmentImageError {
  readonly code = "workflow_unavailable";
}

export class EnvironmentImageProviderUnconfiguredError extends EnvironmentImageError {
  readonly code = "provider_unconfigured";
}

export class EnvironmentImageTriggerFailedError extends EnvironmentImageError {
  readonly code = "trigger_failed";

  constructor(message = "Failed to trigger build", cause?: unknown) {
    super(message, cause);
  }
}

export class EnvironmentImageInvalidCallbackError extends EnvironmentImageError {
  readonly code = "invalid_callback";
}

export class EnvironmentImageCallbackAuthRejectedError extends EnvironmentImageError {
  readonly code = "callback_auth_rejected";
}

export class EnvironmentImageCallbackAuthUnavailableError extends EnvironmentImageError {
  readonly code = "callback_auth_unavailable";
}

export class EnvironmentImageCompletionNotAcceptedError extends EnvironmentImageError {
  readonly code = "completion_not_accepted";
}

export class EnvironmentImageFailureNotAcceptedError extends EnvironmentImageError {
  readonly code = "failure_not_accepted";
}

export class EnvironmentImageBuildCompleteFailedError extends EnvironmentImageError {
  readonly code = "build_complete_failed";

  constructor(message = "Failed to mark build as ready", cause?: unknown) {
    super(message, cause);
  }
}

export class EnvironmentImageBuildFailedUpdateError extends EnvironmentImageError {
  readonly code = "build_failed_update_failed";

  constructor(message = "Failed to mark build as failed", cause?: unknown) {
    super(message, cause);
  }
}
