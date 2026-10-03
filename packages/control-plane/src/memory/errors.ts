/** Expected memory request failures; routes translate `status` to an HTTP response. */
export class MemoryError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 428
  ) {
    super(message);
  }
}

/** A stale revision, lost race, quota, or replacement guard; reload and retry. */
export class MemoryConflictError extends MemoryError {
  constructor(message: string) {
    super(message, 409);
  }
}

export class MemoryValidationError extends MemoryError {
  constructor(message: string) {
    super(message, 400);
  }
}

export class MemoryAccessError extends MemoryError {
  constructor(message: string) {
    super(message, 403);
  }
}

/** Missing or concealed records; inaccessible memories are indistinguishable from absent ones. */
export class MemoryNotFoundError extends MemoryError {
  constructor(message = "Memory not found") {
    super(message, 404);
  }
}
