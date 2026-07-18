/**
 * Session-diff error taxonomy. The HTTP handler maps codes to statuses;
 * the service and store throw these instead of returning Responses.
 */

export type SessionDiffErrorCode =
  | "invalid_bundle"
  | "repository_mismatch"
  | "baseline_unavailable"
  | "baseline_mismatch"
  | "invalid_failure"
  | "invalid_file_identity"
  | "diff_revision_stale"
  | "diff_file_not_found"
  | "sandbox_not_connected";

export abstract class SessionDiffError extends Error {
  abstract readonly code: SessionDiffErrorCode;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

export class InvalidDiffBundleError extends SessionDiffError {
  readonly code = "invalid_bundle";

  constructor() {
    super("Invalid session diff bundle");
  }
}

export class DiffRepositoryMismatchError extends SessionDiffError {
  readonly code = "repository_mismatch";

  constructor() {
    super("Repository set does not match session");
  }
}

export class DiffBaselineUnavailableError extends SessionDiffError {
  readonly code = "baseline_unavailable";

  constructor() {
    super("Session start baseline is unavailable");
  }
}

export class DiffBaselineMismatchError extends SessionDiffError {
  readonly code = "baseline_mismatch";

  constructor() {
    super("Repository baseline does not match session");
  }
}

export class InvalidDiffFailureError extends SessionDiffError {
  readonly code = "invalid_failure";

  constructor() {
    super("Invalid session diff failure");
  }
}

export class InvalidDiffFileIdentityError extends SessionDiffError {
  readonly code = "invalid_file_identity";

  constructor() {
    super("Invalid diff file identity");
  }
}

export class DiffRevisionStaleError extends SessionDiffError {
  readonly code = "diff_revision_stale";

  constructor(readonly currentRevisionId: string | null) {
    super("Diff revision is stale");
  }
}

export class DiffFileNotFoundError extends SessionDiffError {
  readonly code = "diff_file_not_found";

  constructor(readonly currentRevisionId: string | null) {
    super("Diff file not found");
  }
}

export class SandboxNotConnectedError extends SessionDiffError {
  readonly code = "sandbox_not_connected";

  constructor() {
    super("Sandbox is not connected");
  }
}

/**
 * Closed union of every concrete session-diff error. Lets handlers switch
 * exhaustively on `code` and reach payload fields like `currentRevisionId`.
 */
export type SessionDiffDomainError =
  | InvalidDiffBundleError
  | DiffRepositoryMismatchError
  | DiffBaselineUnavailableError
  | DiffBaselineMismatchError
  | InvalidDiffFailureError
  | InvalidDiffFileIdentityError
  | DiffRevisionStaleError
  | DiffFileNotFoundError
  | SandboxNotConnectedError;
