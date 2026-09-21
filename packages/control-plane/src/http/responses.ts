/** Create a JSON response without framework-added content-type parameters. */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Create the control plane's standard JSON error envelope. `code` is a stable
 * machine-readable reason for clients that branch on it.
 */
export function error(message: string, status = 400, code?: string): Response {
  return json(code === undefined ? { error: message } : { error: message, code }, status);
}

/**
 * Raise from a route handler or helper to request a specific HTTP response.
 * The route handler boundary maps this without exposing framework errors.
 */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "HttpError";
  }
}
