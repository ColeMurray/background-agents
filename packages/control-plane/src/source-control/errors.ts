/**
 * Source control provider errors.
 *
 * Error classes and types for source control operations.
 */

import type { z } from "zod";

/**
 * Error classification for source control operations.
 *
 * Transient errors (network issues, rate limits) can be retried.
 * Permanent errors (invalid config, unauthorized) should not be retried.
 */
export type SourceControlErrorType = "transient" | "permanent";

/**
 * Custom error class for source control provider operations.
 *
 * Includes error type classification for retry handling.
 */
export class SourceControlProviderError extends Error {
  constructor(
    message: string,
    public readonly errorType: SourceControlErrorType,
    public readonly httpStatus?: number,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "SourceControlProviderError";
    // Maintain proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SourceControlProviderError);
    }
  }

  /**
   * Check if an HTTP status code indicates a transient error.
   */
  static isTransientStatus(status: number): boolean {
    // 429 = Rate Limited; 5xx = upstream/server errors.
    return status === 429 || (status >= 500 && status <= 599);
  }

  /**
   * Check if an error is likely a transient network error.
   */
  static isTransientNetworkError(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return (
        message.includes("fetch failed") ||
        message.includes("etimedout") ||
        message.includes("econnreset") ||
        message.includes("econnrefused") ||
        message.includes("network") ||
        message.includes("timeout") ||
        message.includes("aborted")
      );
    }
    return false;
  }

  /**
   * Create a SourceControlProviderError from a fetch error or HTTP response.
   */
  static fromFetchError(
    message: string,
    error: unknown,
    status?: number
  ): SourceControlProviderError {
    // Classify based on HTTP status if available
    if (status !== undefined) {
      const errorType = SourceControlProviderError.isTransientStatus(status)
        ? "transient"
        : "permanent";
      return new SourceControlProviderError(
        message,
        errorType,
        status,
        error instanceof Error ? error : undefined
      );
    }

    // Classify based on error type
    const errorType = SourceControlProviderError.isTransientNetworkError(error)
      ? "transient"
      : "permanent";
    return new SourceControlProviderError(
      message,
      errorType,
      undefined,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Parse a provider API response body against its wire schema.
 *
 * A body that is not JSON or does not match the schema throws a permanent
 * SourceControlProviderError naming the offending fields — provider/schema
 * drift must fail loudly rather than flow onward as apparently-valid state.
 */
export async function parseProviderResponse<Schema extends z.ZodType>(
  response: Response,
  schema: Schema,
  context: string
): Promise<z.output<Schema>> {
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new SourceControlProviderError(`${context}: response body is not JSON`, "permanent");
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(root)")),
    ].join(", ");
    throw new SourceControlProviderError(
      `${context}: unexpected response shape (${fields})`,
      "permanent"
    );
  }
  return parsed.data;
}
