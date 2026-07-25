/**
 * App-owned browser-to-BFF request boundary.
 *
 * This preparatory implementation deliberately delegates to fetch unchanged.
 * Terminal browser authentication can add its request contract here without
 * another repository-wide consumer migration.
 */
export function browserApiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return init === undefined ? fetch(input) : fetch(input, init);
}
