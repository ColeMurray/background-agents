/** Where a tool can cause observable work. This is metadata only. */
export const TOOL_EFFECT_KINDS = [
  "local_read",
  "local_mutation",
  "external_read",
  "external_mutation",
  "sandbox_execution",
  "control",
] as const;

export type ToolEffectKind = (typeof TOOL_EFFECT_KINDS)[number];

/** Canonical effect classification for any exposed sandbox process execution. */
export const SANDBOX_EXECUTION_TOOL_EFFECT = "sandbox_execution" satisfies ToolEffectKind;

/** The callers which may invoke a registered tool. */
export const TOOL_CALLERS = ["model", "tools"] as const;

export type ToolCaller = (typeof TOOL_CALLERS)[number];

/** The replay declarations. */
export const TOOL_REPLAY_POLICIES = ["safe", "unsafe"] as const;

export type ToolReplayPolicy = (typeof TOOL_REPLAY_POLICIES)[number];

export interface ToolEffectRegistration {
  readonly name: string;
  readonly effect: ToolEffectKind;
  readonly callers: readonly ToolCaller[];
  readonly replay: ToolReplayPolicy;
}

/**
 * Build a lookup while rejecting accidental tool shadowing across extensions.
 */
/** Build a lookup while rejecting accidental tool shadowing across extensions. */
export function createToolEffectRegistry(
  ...registrationGroups: readonly (readonly ToolEffectRegistration[])[]
): ReadonlyMap<string, ToolEffectRegistration> {
  const registry = new Map<string, ToolEffectRegistration>();
  for (const registration of registrationGroups.flat()) {
    if (registry.has(registration.name)) {
      throw new Error(`Duplicate tool effect registration: "${registration.name}"`);
    }
    registry.set(registration.name, registration);
  }
  return registry;
}
