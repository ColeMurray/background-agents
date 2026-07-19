/**
 * Session-diff domain errors. The service and store throw these instead of
 * returning Responses; the HTTP handler maps each class to a status via
 * instanceof (see routes/automations.ts TargetSelectionError for precedent).
 */

export class InvalidDiffBundleError extends Error {
  constructor() {
    super("Invalid session diff bundle");
    this.name = "InvalidDiffBundleError";
  }
}

export class DiffRepositoryMismatchError extends Error {
  constructor() {
    super("Repository set does not match session");
    this.name = "DiffRepositoryMismatchError";
  }
}

export class DiffBaselineUnavailableError extends Error {
  constructor() {
    super("Session start baseline is unavailable");
    this.name = "DiffBaselineUnavailableError";
  }
}

export class DiffBaselineMismatchError extends Error {
  constructor() {
    super("Repository baseline does not match session");
    this.name = "DiffBaselineMismatchError";
  }
}

export class InvalidDiffFailureError extends Error {
  constructor() {
    super("Invalid session diff failure");
    this.name = "InvalidDiffFailureError";
  }
}

export class InvalidDiffFileIdentityError extends Error {
  constructor() {
    super("Invalid diff file identity");
    this.name = "InvalidDiffFileIdentityError";
  }
}

export class DiffRevisionStaleError extends Error {
  constructor(readonly currentRevisionId: string | null) {
    super("Diff revision is stale");
    this.name = "DiffRevisionStaleError";
  }
}

export class DiffFileNotFoundError extends Error {
  constructor(readonly currentRevisionId: string | null) {
    super("Diff file not found");
    this.name = "DiffFileNotFoundError";
  }
}

export class SandboxNotConnectedError extends Error {
  constructor() {
    super("Sandbox is not connected");
    this.name = "SandboxNotConnectedError";
  }
}
