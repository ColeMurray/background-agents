import type { RouteParams } from "../routes/shared";

/**
 * Path parameters as the raw, undecoded segments of the request pathname.
 *
 * Hono decodes `c.req.param()` and leaves a segment it cannot decode as it
 * arrived, so admission reads the raw segments back from the pathname by
 * position to refuse malformed encoding. The route is already selected, so
 * the parameter and pathname segments line up as long as the path grammar
 * admits only literal and `:param` segments; a mismatch is an invariant
 * violation, not data.
 */
export function rawRouteParams(routePath: string, pathname: string): RouteParams {
  const names = routePath.split("/");
  const values = pathname.split("/");
  if (names.length !== values.length) {
    throw new Error(`Pathname ${pathname} does not line up with route ${routePath}`);
  }
  // A null prototype keeps a parameter named like an Object property (for
  // example `__proto__`) an own entry rather than a prototype write.
  const params: Record<string, string> = Object.create(null);
  names.forEach((segment, index) => {
    if (segment.startsWith(":")) params[segment.slice(1)] = values[index];
  });
  return params;
}
