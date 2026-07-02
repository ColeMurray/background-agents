export const REPO_IMAGE_REPOSITORY_NOT_INSTALLED_MESSAGE =
  "Repository is not installed for the GitHub App";

export type RepoImageErrorCode =
  | "repository_not_installed"
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

export abstract class RepoImageError extends Error {
  abstract readonly code: RepoImageErrorCode;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

export class RepoImageRepositoryNotInstalledError extends RepoImageError {
  readonly code = "repository_not_installed";

  constructor(message = REPO_IMAGE_REPOSITORY_NOT_INSTALLED_MESSAGE) {
    super(message);
  }
}

export class RepoImagePlanningError extends RepoImageError {
  readonly code = "planning_failed";
}

export class RepoImageWorkflowUnavailableError extends RepoImageError {
  readonly code = "workflow_unavailable";
}

export class RepoImageProviderUnconfiguredError extends RepoImageError {
  readonly code = "provider_unconfigured";
}

export class RepoImageTriggerFailedError extends RepoImageError {
  readonly code = "trigger_failed";

  constructor(message = "Failed to trigger build", cause?: unknown) {
    super(message, cause);
  }
}

export class RepoImageInvalidCallbackError extends RepoImageError {
  readonly code = "invalid_callback";
}

export class RepoImageCallbackAuthRejectedError extends RepoImageError {
  readonly code = "callback_auth_rejected";
}

export class RepoImageCallbackAuthUnavailableError extends RepoImageError {
  readonly code = "callback_auth_unavailable";
}

export class RepoImageCompletionNotAcceptedError extends RepoImageError {
  readonly code = "completion_not_accepted";
}

export class RepoImageFailureNotAcceptedError extends RepoImageError {
  readonly code = "failure_not_accepted";
}

export class RepoImageBuildCompleteFailedError extends RepoImageError {
  readonly code = "build_complete_failed";

  constructor(message = "Failed to mark build as ready", cause?: unknown) {
    super(message, cause);
  }
}

export class RepoImageBuildFailedUpdateError extends RepoImageError {
  readonly code = "build_failed_update_failed";

  constructor(message = "Failed to mark build as failed", cause?: unknown) {
    super(message, cause);
  }
}
