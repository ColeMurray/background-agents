import type { Extension } from "@earendil-works/pi-durable";

/**
 * The only supported installation order for first-class Pi extensions.
 * Policy hooks lead; feature tools follow the existing core extensions.
 */
export const PI_EXTENSION_SLOTS = [
  "policy",
  "core",
  "delegation",
  "skills",
  "workspace",
  "code_mode",
  "sandbox_execution",
  "external_actions",
  "mcp",
] as const;

export type PiExtensionSlot = (typeof PI_EXTENSION_SLOTS)[number];

export interface PiExtensionContribution {
  readonly slot: PiExtensionSlot;
  readonly extension: Extension;
}

const slotOrder = new Map(PI_EXTENSION_SLOTS.map((slot, index) => [slot, index]));

/** Validate and order extension declarations before any extension is installed. */
export function assemblePiExtensions(
  contributions: readonly PiExtensionContribution[]
): Extension[] {
  const slots = new Set<PiExtensionSlot>();
  const names = new Set<string>();
  for (const { slot, extension } of contributions) {
    if (slots.has(slot)) throw new Error(`Duplicate Pi extension slot: "${slot}"`);
    if (names.has(extension.name)) {
      throw new Error(`Duplicate Pi extension name: "${extension.name}"`);
    }
    slots.add(slot);
    names.add(extension.name);
  }

  return [...contributions]
    .sort((left, right) => slotOrder.get(left.slot)! - slotOrder.get(right.slot)!)
    .map(({ extension }) => extension);
}
