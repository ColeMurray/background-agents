/**
 * Source control provider errors.
 *
 * Error classes and types for source control operations.
 */

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
    // 429 = Rate Limited, 502/503/504 = Gateway errors
    return status === 429 || status === 502 || status === 503 || status === 504;
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
