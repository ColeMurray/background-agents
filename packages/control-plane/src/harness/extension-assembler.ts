import {
  TOOL_CALLERS,
  createToolEffectRegistry,
  type FeatureCapabilityMode,
  type ToolEffectKind,
  type ToolEffectRegistration,
} from "@open-inspect/shared";

/**
 * The only supported installation order for first-class extensions.
 * Policy hooks lead; feature tools follow the existing core extensions.
 */
export const EXTENSION_SLOTS = [
  "policy",
  "core",
  "delegation",
  "agent_messaging",
  "skills",
  "scratch_workspace",
  "repository_editing",
  "code_mode",
  "sandbox_execution",
  "mcp",
  "browser",
  "memory",
] as const;

/**
 * A slot a harness runtime installs an extension into.
 *
 * The core declares the slots every harness has. A **deployment** may add
 * its own — the overlay's external-action lane and its cross-session lane
 * both do — so the type is open. The order is fixed regardless: the policy
 * slot first, because the policy hook must be in place before a tool runs,
 * then the slots in declaration order.
 */
export type ExtensionSlot = (typeof EXTENSION_SLOTS)[number] | (string & {});

type ExtensionGate =
  | { readonly feature?: never; readonly minimumCapability?: never }
  | {
      readonly feature: string;
      readonly minimumCapability: Exclude<FeatureCapabilityMode, "off">;
    };

/**
 * Where a contribution's extension comes from.
 *
 * A contribution carries the extension itself, or a factory that builds it
 * once the effect registry is known. Exactly one of the two is set.
 */
interface ExtensionSource<T extends HarnessExtension> {
  readonly extension?: T;
  readonly createExtension?: (effects: ReadonlyMap<string, ToolEffectRegistration>) => T;
}

/**
 * A tool, as the seam sees it.
 *
 * The seam checks a tool's own declaration against the effect registry. It
 * does not build the tool, so it reads only what the check needs.
 */
export interface HarnessTool {
  readonly name: string;
  readonly callers?: readonly string[];
  readonly replay?: string;
}

/**
 * An extension, as the seam sees it.
 *
 * The seam orders and checks extensions; it does not build them. The adapter
 * supplies the runtime's own extension, and the seam reads the name and the
 * tools.
 */
export interface HarnessExtension {
  readonly name: string;
  readonly tools?: readonly HarnessTool[];
}

export type ExtensionContribution<T extends HarnessExtension = HarnessExtension> = {
  readonly slot: ExtensionSlot;
  readonly effects: readonly ToolEffectRegistration[];
  /**
   * The tools whose authority this contribution owns.
   *
   * Every tool that can change something outside the model needs an owner: the
   * owner's policy delegate authorizes it. A mutation tool with no owner would
   * be reachable without any authorization at all, so the assembler refuses
   * to install one.
   */
  readonly ownedToolNames?: readonly string[];
} & ExtensionGate &
  ExtensionSource<T>;

export interface ExtensionAssembly<T extends HarnessExtension = HarnessExtension> {
  readonly extensions: readonly T[];
  readonly effects: ReadonlyMap<string, ToolEffectRegistration>;
}

const slotOrder = new Map<string, number>(EXTENSION_SLOTS.map((slot, index) => [slot, index]));

/**
 * The order the slots install in.
 *
 * The policy slot leads, because a tool must never run before the policy
 * hook that governs it is in place. A slot the core does not declare — a
 * deployment's own — keeps its declaration order, after the core's.
 */
function compareSlots(left: ExtensionSlot, right: ExtensionSlot): number {
  const leftIndex = slotOrder.get(left);
  const rightIndex = slotOrder.get(right);
  if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex;
  if (leftIndex !== undefined) return -1;
  if (rightIndex !== undefined) return 1;
  return 0;
}
const mutatingEffects = new Set<ToolEffectKind>([
  "local_mutation",
  "external_mutation",
  "sandbox_execution",
]);

/** Validate and order every active declaration before any extension is installed. */
export function assembleExtensions<T extends HarnessExtension>(
  contributions: readonly ExtensionContribution<T>[],
  capabilities: Readonly<Record<string, FeatureCapabilityMode>>
): ExtensionAssembly<T> {
  const active = contributions.filter((contribution) =>
    isContributionEnabled(contribution, capabilities)
  );
  validateUniqueSlots(active);

  const effects = createToolEffectRegistry(...active.map(({ effects }) => effects));
  const resolved = active.map((contribution) => ({
    contribution,
    extension: resolveExtension(contribution, effects),
  }));
  validateExtensions(resolved, effects);

  const hasPolicy = active.some(({ slot }) => slot === "policy");
  const hasMutation = [...effects.values()].some(({ effect }) => mutatingEffects.has(effect));
  if (hasMutation && !hasPolicy) {
    throw new Error("Mutating tool contributions require the policy extension");
  }
  if (effects.size > 0 && !hasPolicy) {
    throw new Error("Tool contributions require the composite policy extension");
  }
  validateMutationOwnership(active, effects);

  return {
    effects,
    extensions: resolved
      .sort((left, right) => compareSlots(left.contribution.slot, right.contribution.slot))
      .map(({ extension }) => extension),
  };
}

/**
 * The extension a contribution brings.
 *
 * A contribution carries the extension itself, or a factory that builds it
 * once the effect registry is known.
 */
function resolveExtension<T extends HarnessExtension>(
  source: ExtensionSource<T>,
  effects: ReadonlyMap<string, ToolEffectRegistration>
): T {
  if (source.createExtension !== undefined) return source.createExtension(effects);
  if (source.extension !== undefined) return source.extension;
  throw new Error("A contribution must carry an extension or a factory for one");
}

/**
 * Every tool that changes something outside the model needs an owner.
 *
 * The owner's policy delegate is what authorizes the call, so a mutation tool
 * with no owner would be reachable without any authorization. The assembler
 * refuses to install such a runtime rather than leaving the capability open.
 *
 * The check covers the external mutations. Their authority lives in a
 * delegate of their own — the browser delegate, the memory delegate — so one
 * of them has to name the tool it owns. The local and the sandbox effects are
 * authorized by the delegates inside the policy extension, which is always
 * installed.
 */
function validateMutationOwnership<T extends HarnessExtension>(
  contributions: readonly ExtensionContribution<T>[],
  effects: ReadonlyMap<string, ToolEffectRegistration>
): void {
  const owned = new Set<string>();
  for (const contribution of contributions) {
    for (const name of contribution.ownedToolNames ?? []) owned.add(name);
  }
  for (const [name, registration] of effects) {
    if (registration.effect !== "external_mutation") continue;
    if (!owned.has(name)) {
      throw new Error(`Tool effect declaration has no owning policy delegate: "${name}"`);
    }
  }
}

function isContributionEnabled<T extends HarnessExtension>(
  contribution: ExtensionContribution<T>,
  capabilities: Readonly<Record<string, FeatureCapabilityMode>>
): boolean {
  if (contribution.feature === undefined) return true;
  const available = capabilities[contribution.feature];
  return (
    available === "enabled" ||
    (available === "read_only" && contribution.minimumCapability === "read_only")
  );
}

function validateUniqueSlots<T extends HarnessExtension>(
  contributions: readonly ExtensionContribution<T>[]
): void {
  const slots = new Set<ExtensionSlot>();
  for (const { slot } of contributions) {
    if (slots.has(slot)) throw new Error(`Duplicate extension slot: "${slot}"`);
    slots.add(slot);
  }
}

function validateExtensions<T extends HarnessExtension>(
  resolved: readonly {
    readonly contribution: ExtensionContribution<T>;
    readonly extension: T;
  }[],
  effects: ReadonlyMap<string, ToolEffectRegistration>
): void {
  const extensionNames = new Set<string>();
  const tools = new Map<string, HarnessTool>();
  for (const { extension } of resolved) {
    if (extensionNames.has(extension.name)) {
      throw new Error(`Duplicate extension name: "${extension.name}"`);
    }
    extensionNames.add(extension.name);
    for (const tool of extension.tools ?? []) {
      if (tools.has(tool.name)) throw new Error(`Duplicate tool name: "${tool.name}"`);
      tools.set(tool.name, tool);
    }
  }

  for (const [name, tool] of tools) {
    const declaration = effects.get(name);
    if (!declaration) throw new Error(`Tool has no effect declaration: "${name}"`);
    if (!sameCallers(tool.callers ?? TOOL_CALLERS, declaration.callers)) {
      throw new Error(`Tool callers do not match declaration: "${name}"`);
    }
    if ((tool.replay ?? "unsafe") !== declaration.replay) {
      throw new Error(`Tool replay does not match declaration: "${name}"`);
    }
  }
  for (const name of effects.keys()) {
    if (!tools.has(name)) throw new Error(`Tool effect declaration has no tool: "${name}"`);
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
