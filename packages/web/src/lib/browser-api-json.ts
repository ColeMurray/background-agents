import { z } from "zod";
import { browserApiFetch, type BrowserApiPath } from "./browser-api-fetch";

const errorResponseSchema = z.object({ error: z.string() });

/**
 * A JSON request to the BFF whose response is validated by `schema`. Failures throw the server's
 * `error` message, or `fallbackMessage` when the response carries none.
 */
export async function browserApiJson<T>(
  path: BrowserApiPath,
  schema: z.ZodType<T>,
  fallbackMessage: string,
  init?: RequestInit
): Promise<T> {
  const response = await browserApiFetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const parsedError = errorResponseSchema.safeParse(data);
    throw new Error(parsedError.success ? parsedError.data.error : fallbackMessage);
  }
  return schema.parse(data);
}
