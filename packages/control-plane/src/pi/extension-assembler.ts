import {
  TOOL_CALLERS,
  createToolEffectRegistry,
  type FeatureCapabilityMode,
  type PiFeatureCapabilityMatrix,
  type PiFeatureId,
  type ToolEffectKind,
  type ToolEffectRegistration,
} from "@open-inspect/shared";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";

/**
 * The only supported installation order for first-class Pi extensions.
 * Policy hooks lead; feature tools follow the existing core extensions.
 */
export const PI_EXTENSION_SLOTS = [
  "policy",
  "core",
  "delegation",
  "agent_messaging",
  "skills",
  "workspace",
  "repository_editing",
  "code_mode",
  "sandbox_execution",
  "external_actions",
  "mcp",
] as const;

export type PiExtensionSlot = (typeof PI_EXTENSION_SLOTS)[number];

type PiExtensionGate =
  | { readonly feature?: never; readonly minimumCapability?: never }
  | {
      readonly feature: PiFeatureId;
      readonly minimumCapability: Exclude<FeatureCapabilityMode, "off">;
    };

type PiExtensionSource =
  | {
      readonly extension: Extension;
      readonly createExtension?: never;
    }
  | {
      readonly extension?: never;
      readonly createExtension: (effects: ReadonlyMap<string, ToolEffectRegistration>) => Extension;
    };

export type PiExtensionContribution = {
  readonly slot: PiExtensionSlot;
  readonly effects: readonly ToolEffectRegistration[];
} & PiExtensionGate &
  PiExtensionSource;

export interface PiExtensionAssembly {
  readonly extensions: readonly Extension[];
  readonly effects: ReadonlyMap<string, ToolEffectRegistration>;
}

const slotOrder = new Map(PI_EXTENSION_SLOTS.map((slot, index) => [slot, index]));
const mutatingEffects = new Set<ToolEffectKind>([
  "local_mutation",
  "external_mutation",
  "sandbox_execution",
]);

/** Validate and order every active declaration before any extension is installed. */
export function assemblePiExtensions(
  contributions: readonly PiExtensionContribution[],
  capabilities: PiFeatureCapabilityMatrix
): PiExtensionAssembly {
  const active = contributions.filter((contribution) =>
    isContributionEnabled(contribution, capabilities)
  );
  validateUniqueSlots(active);

  const effects = createToolEffectRegistry(...active.map(({ effects }) => effects));
  const resolved = active.map((contribution) => ({
    contribution,
    extension: contribution.extension ?? contribution.createExtension(effects),
  }));
  validateExtensions(resolved, effects);

  const hasPolicy = active.some(({ slot }) => slot === "policy");
  const hasMutation = [...effects.values()].some(({ effect }) => mutatingEffects.has(effect));
  if (hasMutation && !hasPolicy) {
    throw new Error("Mutating Pi tool contributions require the policy extension");
  }
  if (effects.size > 0 && !hasPolicy) {
    throw new Error("Pi tool contributions require the composite policy extension");
  }

  return {
    effects,
    extensions: resolved
      .sort(
        (left, right) =>
          slotOrder.get(left.contribution.slot)! - slotOrder.get(right.contribution.slot)!
      )
      .map(({ extension }) => extension),
  };
}

function isContributionEnabled(
  contribution: PiExtensionContribution,
  capabilities: PiFeatureCapabilityMatrix
): boolean {
  if (contribution.feature === undefined) return true;
  const available = capabilities[contribution.feature];
  return (
    available === "enabled" ||
    (available === "read_only" && contribution.minimumCapability === "read_only")
  );
}

function validateUniqueSlots(contributions: readonly PiExtensionContribution[]): void {
  const slots = new Set<PiExtensionSlot>();
  for (const { slot } of contributions) {
    if (slots.has(slot)) throw new Error(`Duplicate Pi extension slot: "${slot}"`);
    slots.add(slot);
  }
}

function validateExtensions(
  resolved: readonly {
    readonly contribution: PiExtensionContribution;
    readonly extension: Extension;
  }[],
  effects: ReadonlyMap<string, ToolEffectRegistration>
): void {
  const extensionNames = new Set<string>();
  const tools = new Map<string, ToolRegistration>();
  for (const { extension } of resolved) {
    if (extensionNames.has(extension.name)) {
      throw new Error(`Duplicate Pi extension name: "${extension.name}"`);
    }
    extensionNames.add(extension.name);
    for (const tool of extension.tools ?? []) {
      if (tools.has(tool.name)) throw new Error(`Duplicate Pi tool name: "${tool.name}"`);
      tools.set(tool.name, tool);
    }
  }

  for (const [name, tool] of tools) {
    const declaration = effects.get(name);
    if (!declaration) throw new Error(`Pi tool has no effect declaration: "${name}"`);
    if (!sameCallers(tool.callers ?? TOOL_CALLERS, declaration.callers)) {
      throw new Error(`Pi tool callers do not match declaration: "${name}"`);
    }
    if ((tool.replay ?? "unsafe") !== declaration.replay) {
      throw new Error(`Pi tool replay does not match declaration: "${name}"`);
    }
  }
  for (const name of effects.keys()) {
    if (!tools.has(name)) throw new Error(`Pi tool effect declaration has no tool: "${name}"`);
  }
}

function sameCallers(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === left.length &&
    rightSet.size === right.length &&
    leftSet.size === rightSet.size &&
    [...leftSet].every((caller) => rightSet.has(caller))
  );
}
