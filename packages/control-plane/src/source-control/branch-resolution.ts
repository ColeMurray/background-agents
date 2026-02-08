export interface ResolveHeadBranchForPrInput {
  requestedHeadBranch?: string;
  sessionBranchName: string | null;
  generatedBranchName: string;
  baseBranch: string;
}

export interface ResolveHeadBranchForPrResult {
  headBranch: string;
  source: "request" | "session" | "generated";
}

export function normalizeBranchName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Conservative branch-name sanitization for create-PR requests.
 */
export function sanitizeBranchName(name: string | null | undefined): string | null {
  if (!name) {
    return null;
  }

  const trimmed = name.trim();
  if (!trimmed || trimmed === "HEAD") {
    return null;
  }

  if (
    trimmed.startsWith("/") ||
    trimmed.endsWith("/") ||
    trimmed.startsWith(".") ||
    trimmed.endsWith(".") ||
    trimmed.includes(" ") ||
    trimmed.includes("..") ||
    trimmed.includes("@{") ||
    /[~^:?*[\]\\]/.test(trimmed)
  ) {
    return null;
  }

  return trimmed;
}

/**
 * Resolve the source branch for PR creation using deterministic precedence.
 */
export function resolveHeadBranchForPr(
  params: ResolveHeadBranchForPrInput
): ResolveHeadBranchForPrResult {
  const normalizedBase = normalizeBranchName(params.baseBranch);
  const candidates: Array<{
    value: string | null | undefined;
    source: ResolveHeadBranchForPrResult["source"];
  }> = [
    { value: params.requestedHeadBranch, source: "request" },
    { value: params.sessionBranchName, source: "session" },
    { value: params.generatedBranchName, source: "generated" },
  ];

  for (const candidate of candidates) {
    const sanitized = sanitizeBranchName(candidate.value);
    if (!sanitized) {
      continue;
    }

    if (normalizeBranchName(sanitized) === normalizedBase) {
      continue;
    }

    return {
      headBranch: sanitized,
      source: candidate.source,
    };
  }

  return {
    headBranch: params.generatedBranchName,
    source: "generated",
  };
}
