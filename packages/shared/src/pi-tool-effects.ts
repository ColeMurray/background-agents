/** Where a Pi tool can cause observable work. This is metadata only. */
export const TOOL_EFFECT_KINDS = [
  "local_read",
  "local_mutation",
  "external_read",
  "external_mutation",
  "sandbox_execution",
  "control",
] as const;

export type ToolEffectKind = (typeof TOOL_EFFECT_KINDS)[number];

/** Pi Durable callers which may invoke a registered tool. */
export const TOOL_CALLERS = ["model", "tools"] as const;

export type ToolCaller = (typeof TOOL_CALLERS)[number];

/** Pi Durable replay declarations. */
export const TOOL_REPLAY_POLICIES = ["safe", "unsafe"] as const;

export type ToolReplayPolicy = (typeof TOOL_REPLAY_POLICIES)[number];

export interface ToolEffectRegistration {
  readonly name: string;
  readonly effect: ToolEffectKind;
  readonly callers: readonly ToolCaller[];
  readonly replay: ToolReplayPolicy;
}

/**
 * Effect declarations for the stable Pi tools that predate feature extensions.
 * Feature implementations append their own declarations through
 * createToolEffectRegistry before installing tools.
 */
export const PI_TOOL_EFFECT_REGISTRATIONS = [
  {
    name: "repository_list",
    effect: "external_read",
    callers: ["model", "tools"],
    replay: "safe",
  },
  {
    name: "repository_read",
    effect: "external_read",
    callers: ["model", "tools"],
    replay: "safe",
  },
  { name: "subagent", effect: "control", callers: ["model"], replay: "safe" },
  { name: "read", effect: "local_read", callers: ["model", "tools"], replay: "safe" },
  { name: "ls", effect: "local_read", callers: ["model", "tools"], replay: "safe" },
  { name: "find", effect: "local_read", callers: ["model", "tools"], replay: "safe" },
  { name: "grep", effect: "local_read", callers: ["model", "tools"], replay: "safe" },
] as const satisfies readonly ToolEffectRegistration[];

/** Build a lookup while rejecting accidental tool shadowing across extensions. */
export function createToolEffectRegistry(
  ...registrationGroups: readonly (readonly ToolEffectRegistration[])[]
): ReadonlyMap<string, ToolEffectRegistration> {
  const registry = new Map<string, ToolEffectRegistration>();
  for (const registration of registrationGroups.flat()) {
    if (registry.has(registration.name)) {
      throw new Error(`Duplicate Pi tool effect registration: "${registration.name}"`);
    }
    registry.set(registration.name, registration);
  }
  return registry;
}

/** Baseline registry; feature branches should compose this declaration list with their own. */
export const PI_TOOL_EFFECT_REGISTRY = createToolEffectRegistry(PI_TOOL_EFFECT_REGISTRATIONS);
