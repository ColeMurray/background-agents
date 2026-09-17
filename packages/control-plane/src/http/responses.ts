/** Create a JSON response without framework-added content-type parameters. */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Create the control plane's standard JSON error envelope. */
export function error(message: string, status = 400): Response {
  return json({ error: message }, status);
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
