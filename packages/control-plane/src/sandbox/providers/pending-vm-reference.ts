const PREFIX = "modal-vm-session:";

/**
 * Format modal-vm-session:["sessionId","sandboxId"]. Session names the allocation;
 * both ids name its ownership tags.
 */
export function formatPendingVmReference(sessionId: string, sandboxId: string): string {
  return `${PREFIX}${JSON.stringify([sessionId, sandboxId])}`;
}

/**
 * Parse a reference, which resolves only while its generation's allocation runs.
 * An invisible allocation is confirmed absent only after the launch window,
 * endpoint timeout and margin (PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS).
 */
export function parsePendingVmReference(
  value: string
): { sessionId: string; sandboxId: string } | null {
  if (!value.startsWith(PREFIX)) return null;
  try {
    const identity: unknown = JSON.parse(value.slice(PREFIX.length));
    if (
      !Array.isArray(identity) ||
      identity.length !== 2 ||
      !identity.every((part) => typeof part === "string" && part.length > 0)
    )
      return null;
    return { sessionId: identity[0], sandboxId: identity[1] };
  } catch {
    return null;
  }
}
