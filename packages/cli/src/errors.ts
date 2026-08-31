const CLI_EXIT_CODES = {
  general: 1,
  auth: 2,
  validation: 3,
  conflict: 4,
  timeout: 5,
  transport: 6,
  service: 7,
  not_found: 8,
  expired: 9,
  rate_limited: 10,
} as const;

export type CliErrorKind = keyof typeof CLI_EXIT_CODES;

export class CliError extends Error {
  constructor(
    readonly kind: CliErrorKind,
    message: string,
    readonly status?: number,
    readonly context?: Record<string, string>,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "CliError";
  }
}

export function classifyError(cause: unknown): CliError {
  if (cause instanceof CliError) return cause;
  if (cause instanceof Error && cause.name === "CommanderError")
    return new CliError("validation", safeErrorMessage(cause), undefined, undefined, { cause });
  if (cause instanceof Error && cause.name === "ZodError")
    return new CliError("validation", "Input or response validation failed", undefined, undefined, {
      cause,
    });
  return new CliError("general", safeErrorMessage(cause), undefined, undefined, {
    cause,
  });
}

export function withErrorContext(cause: unknown, context: Record<string, string>): CliError {
  const error = classifyError(cause);
  return new CliError(
    error.kind,
    error.message,
    error.status,
    { ...error.context, ...context },
    {
      cause: error,
    }
  );
}

export function errorEnvelope(cause: unknown) {
  const error = classifyError(cause);
  return {
    error: {
      kind: error.kind,
      message: error.message,
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(error.context ? { context: error.context } : {}),
    },
  };
}

function safeErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : "Unexpected CLI failure";
  const bounded = message
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 512);
  return bounded || "Unexpected CLI failure";
}

export function exitCodeFor(cause: unknown): number {
  return CLI_EXIT_CODES[classifyError(cause).kind];
}
