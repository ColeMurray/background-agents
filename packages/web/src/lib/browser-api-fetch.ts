/**
 * App-owned browser-to-BFF request boundary.
 *
 * The path type keeps application calls on the BFF API surface, while the
 * browser's native request mode prevents cross-origin dispatch.
 */
export type BrowserApiPath = `/api/${string}`;

export function browserApiFetch(input: BrowserApiPath, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    mode: "same-origin",
    credentials: "same-origin",
  });
}
