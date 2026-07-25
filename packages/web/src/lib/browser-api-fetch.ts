/**
 * App-owned browser-to-BFF request boundary.
 *
 * This preparatory implementation deliberately delegates to fetch unchanged.
 * Terminal browser authentication can add its request contract here without
 * another repository-wide consumer migration.
 */
export type BrowserApiPath = `/api/${string}`;

const INVALID_BROWSER_API_PATH_MESSAGE = "Browser API requests must use a same-origin /api/ path";

function assertBrowserApiPath(input: string): asserts input is BrowserApiPath {
  if (!input.startsWith("/api/")) {
    throw new Error(INVALID_BROWSER_API_PATH_MESSAGE);
  }
}

/**
 * Validates a dynamically produced request path before it crosses the
 * browser-to-BFF boundary.
 */
export function toBrowserApiPath(input: string): BrowserApiPath {
  assertBrowserApiPath(input);
  return input;
}

export function browserApiFetch(input: BrowserApiPath, init?: RequestInit): Promise<Response> {
  // Keep a runtime check in addition to the type so untyped JavaScript and
  // unsafe casts cannot attach the terminal auth contract to another origin.
  assertBrowserApiPath(input);
  return init === undefined ? fetch(input) : fetch(input, init);
}
