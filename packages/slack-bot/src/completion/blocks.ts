/**
 * Build Slack Block Kit messages for completion notifications.
 */

import type { AgentResponse, SlackCallbackContext } from "../types";
import { escapeMrkdwnText, type ManualPullRequestArtifactMetadata } from "@open-inspect/shared";

/**
 * Slack Block Kit block type (subset).
 */
interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  elements?: Array<{ type: string; text?: unknown; url?: string; action_id?: string }>;
}

/**
 * Status emoji constants.
 */
const STATUS_EMOJI = {
  success: ":white_check_mark:",
  warning: ":warning:",
} as const;

/**
 * Truncation limits.
 */
const FALLBACK_TEXT_LIMIT = 150;
const ERROR_FOOTER_LIMIT = 200;

/**
 * Slack's hard cap on a section block's mrkdwn text. Responses longer than this
 * are split across consecutive section blocks rather than truncated, so a long
 * answer arrives whole instead of stopping mid-sentence.
 */
const SECTION_TEXT_MAX_CHARS = 3000;

/**
 * How many section blocks a response may occupy. Slack allows 50 blocks per
 * message; the rest of this builder contributes at most 4 (artifacts, tools,
 * footer, actions), so this leaves comfortable headroom. Beyond this the tail is
 * truncated and the View Session button is the way to read the whole thing.
 */
const MAX_RESPONSE_SECTIONS = 20;

const CODE_FENCE = "```";

/**
 * Build Slack blocks for completion message.
 */
export function buildCompletionBlocks(
  sessionId: string,
  response: AgentResponse,
  context: SlackCallbackContext,
  webAppUrl: string
): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  // 1. Response text, split across as many section blocks as it needs
  const sections = splitIntoSlackSections(response.textContent);
  if (sections.length === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "_Agent completed._" } });
  } else {
    for (const section of sections) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: section } });
    }
  }

  // 2. Artifacts (PRs, branches)
  if (response.artifacts.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Created:*\n" + response.artifacts.map((a) => `- <${a.url}|${a.label}>`).join("\n"),
      },
    });
  }

  // 3. Key tool actions
  const keyToolNames = ["Edit", "Write", "Bash"] as const;
  const keyTools = response.toolCalls
    .filter((t) => keyToolNames.includes(t.tool as (typeof keyToolNames)[number]))
    .slice(0, 5);
  if (keyTools.length > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: keyTools.map((t) => t.summary).join(" | ") }],
    });
  }

  // 4. Status footer
  const emoji = response.success ? STATUS_EMOJI.success : STATUS_EMOJI.warning;
  const status = response.success
    ? "Done"
    : response.error
      ? `Failed: ${truncateError(response.error, ERROR_FOOTER_LIMIT)}`
      : "Completed with issues";
  const effortSuffix = context.reasoningEffort ? ` (${context.reasoningEffort})` : "";
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        // The target label is raw user text for environment-launched sessions.
        text: `${emoji} ${status}  |  ${context.model}${effortSuffix}  |  ${escapeMrkdwnText(context.repoFullName)}`,
      },
    ],
  });

  const hasPrArtifact = response.artifacts.some((artifact) => artifact.type === "pr");
  const manualCreatePrUrl = getManualCreatePrUrl(response.artifacts);
  const actionElements: Array<{
    type: string;
    text: { type: string; text: string };
    url: string;
    action_id: string;
  }> = [
    {
      type: "button",
      text: { type: "plain_text", text: "View Session" },
      url: `${webAppUrl}/session/${sessionId}`,
      action_id: "view_session",
    },
  ];

  if (!hasPrArtifact && manualCreatePrUrl) {
    actionElements.push({
      type: "button",
      text: { type: "plain_text", text: "Create PR" },
      url: manualCreatePrUrl,
      action_id: "create_pr",
    });
  }

  // 5. Action buttons
  blocks.push({
    type: "actions",
    elements: actionElements,
  });

  return blocks;
}

/**
 * Get truncated text for Slack's fallback text field.
 */
export function getFallbackText(response: AgentResponse): string {
  return response.textContent.slice(0, FALLBACK_TEXT_LIMIT) || "Agent completed.";
}

interface FenceState {
  readonly open: boolean;
  readonly info: string;
}

const CLOSED_FENCE: FenceState = { open: false, info: "" };
const OPEN_FENCE: FenceState = { open: true, info: "" };

/**
 * Cap on the retained fence info string. An info string is a language token
 * (`ts`, `python`, `json`), so this is generous for real input — but it has to be
 * bounded: `reopenPrefix` re-emits it on every continuation section, so an
 * unbounded capture let a pathologically long fence-opener line push sections
 * past the cap by the length of its info string. Only the first whitespace-
 * delimited token is kept, since anything after it isn't a language.
 */
const FENCE_INFO_MAX_CHARS = 32;

function normalizeFenceInfo(raw: string): string {
  return raw.trim().split(/\s/, 1)[0].slice(0, FENCE_INFO_MAX_CHARS);
}

/** Fence state after `chunk` is appended to text that ended in `state`. */
function advanceFence(state: FenceState, chunk: string): FenceState {
  let next = state;
  for (const line of chunk.split("\n")) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith(CODE_FENCE)) continue;
    next = next.open
      ? CLOSED_FENCE
      : { open: true, info: normalizeFenceInfo(trimmed.slice(CODE_FENCE.length)) };
  }
  return next;
}

/** Reopens, at the top of a section, a fence carried over from the previous one. */
function reopenPrefix(state: FenceState): string {
  return state.open ? `${CODE_FENCE}${state.info}\n` : "";
}

/** Closes a fence still open at the end of a section. */
function closeSuffix(state: FenceState): string {
  return state.open ? `\n${CODE_FENCE}` : "";
}

/**
 * Split agent prose into Slack section blocks, preferring paragraph boundaries.
 *
 * Long answers used to be cut at 2000 characters in a single block, which stopped
 * multi-part answers mid-sentence even though Slack accepts far more. Splitting
 * greedily on blank lines keeps headings with their prose; paragraphs that are
 * themselves oversized fall back to line boundaries, then to a hard slice.
 *
 * Fenced code blocks are closed at the end of a section and reopened at the start
 * of the next, so a split inside a fence doesn't leak monospace formatting across
 * the rest of the message.
 *
 * Both repairs cost characters, so every fit check measures the text Slack will
 * actually receive — reopen prefix plus body plus closing fence — and the
 * hard-slice path advances by exactly what it kept. Measuring the bare body
 * instead lets an in-fence section overflow by the 4 closing characters, and
 * Slack rejects the whole message rather than trimming the block.
 *
 * Returns [] for empty input so the caller can render its own placeholder.
 */
export function splitIntoSlackSections(
  text: string,
  maxChars: number = SECTION_TEXT_MAX_CHARS,
  maxSections: number = MAX_RESPONSE_SECTIONS
): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const sections: string[] = [];
  // Fence state where the in-progress section began, and where its body now ends.
  let sectionStart = CLOSED_FENCE;
  let sectionEnd = CLOSED_FENCE;
  let body = "";

  const render = (start: FenceState, content: string, end: FenceState): string =>
    `${reopenPrefix(start)}${content}${closeSuffix(end)}`;

  const flush = (): void => {
    if (!body) return;
    sections.push(render(sectionStart, body, sectionEnd));
    // A fence left open carries into the next section, which reopens it.
    sectionStart = sectionEnd;
    body = "";
  };

  const appendToken = (token: string, separator: string): void => {
    const joined = body ? `${body}${separator}${token}` : token;
    const joinedEnd = advanceFence(sectionEnd, token);
    if (render(sectionStart, joined, joinedEnd).length <= maxChars) {
      body = joined;
      sectionEnd = joinedEnd;
      return;
    }

    flush();
    const aloneEnd = advanceFence(sectionEnd, token);
    if (render(sectionStart, token, aloneEnd).length <= maxChars) {
      body = token;
      sectionEnd = aloneEnd;
      return;
    }

    // Token exceeds a whole section on its own: slice it against the real budget.
    let rest = token;
    while (rest.length > 0) {
      const start = sectionEnd;
      // Reserve the closing fence whenever this slice could end inside one.
      const reserveClose = start.open || advanceFence(start, rest).open;
      const budget =
        maxChars - reopenPrefix(start).length - (reserveClose ? closeSuffix(OPEN_FENCE).length : 0);
      const taken = rest.slice(0, Math.max(1, budget));
      sectionStart = start;
      body = taken;
      sectionEnd = advanceFence(start, taken);
      rest = rest.slice(taken.length);
      if (rest.length > 0) flush();
    }
  };

  for (const paragraph of trimmed.split(/\n{2,}/)) {
    if (paragraph.length <= maxChars) {
      appendToken(paragraph, "\n\n");
      continue;
    }
    // Oversized paragraph (long table, big code block): break on lines. Only the
    // first line is a paragraph boundary; the rest are line continuations.
    let atParagraphStart = true;
    for (const line of paragraph.split("\n")) {
      appendToken(line, atParagraphStart ? "\n\n" : "\n");
      atParagraphStart = false;
    }
  }
  flush();

  if (sections.length <= maxSections) return sections;
  const kept = sections.slice(0, maxSections);
  const lastIndex = maxSections - 1;
  kept[lastIndex] = withTruncationMarker(kept[lastIndex], maxChars);
  return kept;
}

/**
 * Append the truncation pointer to the final kept section, preserving both the
 * character cap and fence balance — slicing blindly can eat the closing fence and
 * leak monospace over the marker.
 */
function withTruncationMarker(section: string, maxChars: number): string {
  const marker = "\n\n_...truncated — open the session to read the rest_";
  if (section.length + marker.length <= maxChars) return section + marker;
  const closing = `\n${CODE_FENCE}`;
  // Reserve room for a closing fence unconditionally: the cut can land inside a
  // fence this section opened *and* closed, which no trailing-fence check sees.
  const content = section.endsWith(closing) ? section.slice(0, -closing.length) : section;
  const room = maxChars - marker.length - closing.length;
  const sliced = content.slice(0, Math.max(0, room));
  const needsClose = (sliced.match(/```/g) ?? []).length % 2 !== 0;
  return `${sliced}${needsClose ? closing : ""}${marker}`;
}

/**
 * Truncate an error string for Slack display, collapsing whitespace.
 */
export function truncateError(text: string, maxLen: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) return normalized;
  return normalized.slice(0, maxLen - 1) + "…";
}

function getManualCreatePrUrl(artifacts: AgentResponse["artifacts"]): string | null {
  const manualBranchArtifact = artifacts.find((artifact) => {
    if (artifact.type !== "branch") {
      return false;
    }
    if (!artifact.metadata || typeof artifact.metadata !== "object") {
      return false;
    }
    const metadata = artifact.metadata as Partial<ManualPullRequestArtifactMetadata> &
      Record<string, unknown>;
    if (metadata.mode === "manual_pr") {
      return true;
    }
    // Backward-compatible fallback for older artifacts that may not include mode.
    return metadata.mode == null && typeof metadata.createPrUrl === "string";
  });

  if (!manualBranchArtifact) {
    return null;
  }

  const metadataUrl = manualBranchArtifact.metadata?.createPrUrl;
  if (typeof metadataUrl === "string" && metadataUrl.length > 0) {
    return metadataUrl;
  }

  return manualBranchArtifact.url || null;
}
