import type { RouteParams } from "../routes/shared";

/**
 * Path parameters as the raw, undecoded segments of the request pathname.
 *
 * Hono decodes `c.req.param()`, but handlers decode repository and member
 * segments themselves, so the segments are read back from the pathname by
 * position. The route is already selected, so the parameter and pathname
 * segments line up as long as the path grammar admits only literal and
 * `:param` segments.
 */
export function rawRouteParams(routePath: string, pathname: string): RouteParams {
  const values = pathname.split("/");
  const params: Record<string, string> = {};
  routePath.split("/").forEach((segment, index) => {
    if (segment.startsWith(":")) params[segment.slice(1)] = values[index] ?? "";
  });
  return params;
}
