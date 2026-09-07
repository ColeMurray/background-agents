export function hasPositiveTokenUsage(tokens: unknown): boolean {
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return false;

  const usage = tokens as Record<string, unknown>;
  if ([usage.total, usage.input, usage.output, usage.reasoning].some(isPositiveNumber)) return true;

  const cache = usage.cache;
  return (
    !!cache &&
    typeof cache === "object" &&
    !Array.isArray(cache) &&
    [(cache as Record<string, unknown>).read, (cache as Record<string, unknown>).write].some(
      isPositiveNumber
    )
  );
}

function isPositiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
