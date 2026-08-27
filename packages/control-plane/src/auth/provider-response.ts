import type { z } from "zod";
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
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > PROVIDER_RESPONSE_MAX_BYTES) {
    throw oversizedError();
  }
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > PROVIDER_RESPONSE_MAX_BYTES) {
      await reader.cancel();
      throw oversizedError();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
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
