/** What kind of expected failure occurred; routes choose the transport response. */
export type MemoryErrorKind = "validation" | "forbidden" | "not_found" | "conflict";

/** An expected memory request failure. Transport-neutral: see `routes/memory-errors.ts`. */
export class MemoryError extends Error {
  constructor(
    message: string,
    readonly kind: MemoryErrorKind
  ) {
    super(message);
  }
}

/** A stale revision, lost race, quota, or replacement guard; reload and retry. */
export class MemoryConflictError extends MemoryError {
  constructor(message: string) {
    super(message, "conflict");
  }
}

export class MemoryValidationError extends MemoryError {
  constructor(message: string) {
    super(message, "validation");
  }
}

export class MemoryAccessError extends MemoryError {
  constructor(message: string) {
    super(message, "forbidden");
  }
}

/** Missing or concealed records; inaccessible memories are indistinguishable from absent ones. */
export class MemoryNotFoundError extends MemoryError {
  constructor(message = "Memory not found") {
    super(message, "not_found");
  }
}
