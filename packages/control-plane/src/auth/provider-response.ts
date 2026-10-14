import type { z } from "zod";
import { readBoundedBytes } from "../http/bounded-body";
import { PROVIDER_TOKEN_REFRESH_TIMEOUT_MS } from "./provider-token-timeouts";

const PROVIDER_RESPONSE_MAX_BYTES = 64 * 1024;

type ProviderResponseErrorReason = "oversized" | "http" | "invalid_json" | "invalid_data";

export type ProviderResponseErrorFactory = (
  reason: ProviderResponseErrorReason,
  status: number,
  invalidFields?: readonly string[]
) => Error;

export function fetchProvider(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(PROVIDER_TOKEN_REFRESH_TIMEOUT_MS),
  });
}

export async function readBoundedProviderBody(
  response: Response,
  oversizedError: () => Error
): Promise<string> {
  const result = await readBoundedBytes(
    response.body,
    PROVIDER_RESPONSE_MAX_BYTES,
    response.headers.get("content-length")
  );
  if (!result.ok) throw oversizedError();
  return new TextDecoder().decode(result.bytes);
}

export async function parseProviderResponse<T>(
  response: Response,
  schema: z.ZodType<T>,
  createError: ProviderResponseErrorFactory,
  options: { acceptErrorStatus?: boolean } = {}
): Promise<T> {
  const body = await readBoundedProviderBody(response, () =>
    createError("oversized", response.status)
  );
  if (!response.ok && !options.acceptErrorStatus) {
    throw createError("http", response.status);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw createError("invalid_json", response.status);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const fields = [
      ...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? "response"))),
    ];
    throw createError("invalid_data", response.status, fields);
  }
  return result.data;
}
