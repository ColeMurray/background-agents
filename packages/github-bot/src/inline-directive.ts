/**
 * Parses inline `model:` and `reasoning:` directives out of a comment body.
 *
 * Grammar:
 *   - Case-insensitive keys: `model: <name>`, `reasoning: <effort>`.
 *   - Word-boundary required: must be preceded by start-of-string or whitespace,
 *     followed by whitespace or end-of-string. Prevents URL fragments like
 *     `https://example.com/model:opus` and code-span prefixes like `` `model:opus `` from matching.
 *   - First occurrence per key wins; subsequent occurrences are still stripped from
 *     `cleanedBody` so the prompt does not contain stray directive text.
 *   - Model values may be a bare alias (`opus`, `sonnet-4-6`) or fully-qualified
 *     (`anthropic/claude-opus-4-7`); normalized via `normalizeModelId` and
 *     validated via `isValidModel`. Invalid model → field unset, token still stripped.
 *   - Reasoning values are validated globally here (against the shared union); if a
 *     directive model is supplied, also validated against that model. The final
 *     model-specific compatibility check happens in `resolveSessionModelSettings`.
 */

import {
  isValidModel,
  isValidReasoningEffort,
  normalizeModelId,
  resolveModelAlias,
} from "@open-inspect/shared";

export interface ParsedDirective {
  /** Validated, normalized "provider/model" id, or undefined if no valid model directive. */
  model?: string;
  /** Raw reasoning string; further validated against the resolved model downstream. */
  reasoningEffort?: string;
  /** Body with directive tokens (and one trailing whitespace each) removed. */
  cleanedBody: string;
}

/**
 * Reasoning effort values accepted globally across all providers. Mirrors the
 * `ReasoningEffort` union in `@open-inspect/shared`.
 */
const GLOBAL_REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

/**
 * Match a directive token. Anchored on either start-of-string or a whitespace char
 * (captured into group 1) so we can preserve correct spacing when stripping.
 *
 * Captures:
 *   1. leading boundary (empty string at start-of-string, otherwise a single whitespace char)
 *   2. key ("model" or "reasoning"), case-insensitive
 *   3. value (run of non-whitespace chars)
 */
const DIRECTIVE_RE = /(^|\s)(model|reasoning)\s*:\s*(\S+)/gi;

export function parseInlineDirective(body: string): ParsedDirective {
  if (!body) {
    return { cleanedBody: "" };
  }

  let firstModelRaw: string | undefined;
  let firstReasoningRaw: string | undefined;

  // Walk all matches once to locate first occurrences; we need a separate pass
  // for stripping because `replace` semantics differ from match-walking when we
  // also want to consume one trailing whitespace character.
  const scanRe = new RegExp(DIRECTIVE_RE.source, "gi");
  for (let m = scanRe.exec(body); m !== null; m = scanRe.exec(body)) {
    const key = m[2].toLowerCase();
    const value = m[3];
    if (key === "model" && firstModelRaw === undefined) {
      firstModelRaw = value;
    } else if (key === "reasoning" && firstReasoningRaw === undefined) {
      firstReasoningRaw = value;
    }
  }

  // Strip every directive token from the body. We replace each directive with
  // its leading boundary char (preserving whitespace between surrounding text)
  // and then collapse any resulting runs of whitespace to a single space. This
  // approach is robust to back-to-back directives where the second directive's
  // leading whitespace would otherwise be consumed by the first match.
  const stripRe = new RegExp(DIRECTIVE_RE.source, "gi");
  const cleanedBody = body
    .replace(stripRe, (_match, lead: string) => lead)
    .replace(/[ \t]+/g, " ")
    .trim();

  let model: string | undefined;
  if (firstModelRaw !== undefined) {
    const normalized = resolveModelAlias(firstModelRaw);
    if (isValidModel(normalized)) {
      model = normalizeModelId(normalized);
    }
  }

  let reasoningEffort: string | undefined;
  if (firstReasoningRaw !== undefined) {
    const value = firstReasoningRaw.toLowerCase();
    if (GLOBAL_REASONING_EFFORTS.has(value)) {
      // If a directive model is also supplied, only keep reasoning when compatible
      // with it. Otherwise let the resolver validate against the resolved model.
      if (model !== undefined) {
        if (isValidReasoningEffort(model, value)) {
          reasoningEffort = value;
        }
      } else {
        reasoningEffort = value;
      }
    }
  }

  return {
    cleanedBody,
    ...(model !== undefined ? { model } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  };
}
