/**
 * Session context fixed at creation: resolved for a root session, or inherited verbatim from the
 * parent of an agent-spawned child. Exactly one applies.
 */
export type Pinned<T> =
  | { kind: "resolved"; value: T }
  | { kind: "inherited"; parentSessionId: string };

export function resolvedPin<T>(value: T): Pinned<T> {
  return { kind: "resolved", value };
}

export function inheritedPin<T>(parentSessionId: string): Pinned<T> {
  return { kind: "inherited", parentSessionId };
}
