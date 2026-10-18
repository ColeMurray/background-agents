export const PI_TOOL_EFFECTS = [
  "local_read",
  "local_mutation",
  "external_read",
  "external_mutation",
  "unclassified",
] as const;

export type PiToolEffect = (typeof PI_TOOL_EFFECTS)[number];

export const WORKSPACE_TOOL_EFFECT_OWNER = "workspace";

/** Shared metadata consumed by independent local and external-effect policies. */
export interface PiToolEffectMetadata {
  tool: string;
  effect: PiToolEffect;
  owner: string;
  operation: string;
}

export function indexPiToolEffects(
  metadata: readonly PiToolEffectMetadata[]
): ReadonlyMap<string, PiToolEffectMetadata> {
  const byTool = new Map<string, PiToolEffectMetadata>();
  for (const entry of metadata) {
    if (byTool.has(entry.tool)) throw new Error(`Duplicate Pi tool effect metadata: ${entry.tool}`);
    byTool.set(entry.tool, entry);
  }
  return byTool;
}
