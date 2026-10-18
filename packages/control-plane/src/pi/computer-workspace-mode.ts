export type ComputerWorkspaceMode = "off" | "read_only";

/** Unknown deployment values fail closed instead of widening Pi's capabilities. */
export function resolveComputerWorkspaceMode(value: string | undefined): ComputerWorkspaceMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "read_only") return normalized;
  return "off";
}
