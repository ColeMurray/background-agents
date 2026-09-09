import type { z } from "zod";
import { error } from "../http/responses";

/**
 * Parse a request's query string with `schema`, or answer the route's 400.
 *
 * Only the keys the schema declares are read. A key given more than once is
 * refused as `Invalid <key>` before the schema sees it, and a schema failure
 * answers its first issue's message, so each route keeps its own wording.
 */
export function parseQuery<Shape extends z.ZodRawShape>(
  request: Request,
  schema: z.ZodObject<Shape>
): z.output<z.ZodObject<Shape>> | Response {
  const searchParams = new URL(request.url).searchParams;
  const input: Record<string, string> = {};
  for (const key of Object.keys(schema.shape)) {
    const values = searchParams.getAll(key);
    if (values.length > 1) return error(`Invalid ${key}`, 400);
    if (values.length === 1) input[key] = values[0];
  }
  const result = schema.safeParse(input);
  if (!result.success) return error(result.error.issues[0]?.message ?? "Invalid query", 400);
  return result.data;
}
