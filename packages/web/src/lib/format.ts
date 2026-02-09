/**
 * Utility functions for formatting display values
 */

import { MODEL_OPTIONS, normalizeModelId } from "@open-inspect/shared";

// Build a lookup map once at module level
const MODEL_DISPLAY_NAMES = new Map<string, string>(
  MODEL_OPTIONS.flatMap((g) => g.models.map((m) => [m.id, m.name]))
);

/**
 * Format model ID to display name.
 * e.g., "anthropic/claude-sonnet-4-5" → "Claude Sonnet 4.5"
 * e.g., "openai/gpt-5.2-codex" → "GPT 5.2 Codex"
 */
export function formatModelName(modelId: string): string {
  if (!modelId) return "Unknown Model";
  return MODEL_DISPLAY_NAMES.get(normalizeModelId(modelId)) ?? modelId;
}

/**
 * Format model ID to lowercase display format for footer.
 * e.g., "anthropic/claude-sonnet-4-5" → "claude sonnet 4.5"
 */
export function formatModelNameLower(modelId: string): string {
  if (!modelId) return "unknown model";
  return (MODEL_DISPLAY_NAMES.get(normalizeModelId(modelId)) ?? modelId).toLowerCase();
}

/**
 * Truncate branch name with ellipsis at start
 * e.g., "feature/very-long-branch-name-here" → "...long-branch-name-here"
 */
export function truncateBranch(branchName: string, maxLength = 30): string {
  if (!branchName) return "";
  if (branchName.length <= maxLength) return branchName;
  return "..." + branchName.slice(-maxLength);
}

/**
 * Copy text to clipboard
 * Returns true if successful, false otherwise
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    // Fallback for older browsers
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-999999px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const success = document.execCommand("copy");
    textArea.remove();
    return success;
  } catch {
    return false;
  }
}

/**
 * Format file path for display (show basename or last N characters)
 */
export function formatFilePath(
  filePath: string,
  maxLength = 40
): { display: string; full: string } {
  if (!filePath) return { display: "", full: "" };

  const parts = filePath.split("/");
  const basename = parts[parts.length - 1];

  if (basename.length <= maxLength) {
    return { display: basename, full: filePath };
  }

  return {
    display: basename.slice(0, maxLength - 3) + "...",
    full: filePath,
  };
}

/**
 * Format number with +/- prefix for diff stats
 */
export function formatDiffStat(
  additions: number,
  deletions: number
): { additions: string; deletions: string } {
  return {
    additions: additions > 0 ? `+${additions}` : "+0",
    deletions: deletions > 0 ? `-${deletions}` : "-0",
  };
}
