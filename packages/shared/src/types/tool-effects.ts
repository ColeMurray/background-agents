export const LOCAL_READ_TOOL_NAMES = ["read", "ls", "find", "grep"] as const;
export const LOCAL_MUTATION_TOOL_NAMES = ["write", "edit", "delete"] as const;

export type ToolEffect = "local_read" | "local_mutation";

const effects = new Map<string, ToolEffect>([
  ...LOCAL_READ_TOOL_NAMES.map((name) => [name, "local_read"] as const),
  ...LOCAL_MUTATION_TOOL_NAMES.map((name) => [name, "local_mutation"] as const),
]);

/** Explicit built-in classification; unknown tools stay unclassified and fail closed. */
export function classifyToolEffect(toolName: string): ToolEffect | null {
  return effects.get(toolName) ?? null;
}
