import type Anthropic from "@anthropic-ai/sdk";

import type { Logger } from "../../logger";
import type { SpawnSource } from "../../types";
import type { SessionRow } from "../types";
import type { ServerMessage } from "../../types";

const MAX_TITLE_LENGTH = 60;
const TARGET_TITLE_LENGTH = 55;
const UNTITLED = "Untitled session";

interface PrefixSpec {
  prefix: string;
}

function getPrefixSpec(spawnSource: SpawnSource | string | null | undefined): PrefixSpec {
  switch (spawnSource) {
    case "github-bot":
      return { prefix: "GitHub: " };
    case "slack-bot":
      return { prefix: "Slack: " };
    case "linear-bot":
      return { prefix: "Linear: " };
    default:
      return { prefix: "" };
  }
}

function sanitizePromptForTitle(prompt: string): string {
  let cleaned = prompt.replace(/```[\s\S]*?```/g, " ");
  cleaned = cleaned.replace(/https?:\/\/\S+/gi, " ");
  // Strip paired bold/italic asterisks: **bold**, *italic*
  cleaned = cleaned.replace(/\*+([^*\n]+)\*+/g, "$1");
  // Strip paired inline code: `code`
  cleaned = cleaned.replace(/`+([^`\n]+)`+/g, "$1");
  // Strip paired underscore emphasis only when bounded by non-identifier chars
  // (preserves snake_case identifiers like my_var_name)
  cleaned = cleaned.replace(/(^|\W)_+([^_\n]+?)_+(?=\W|$)/g, "$1$2");
  // Strip blockquote markers ONLY at line start (preserves x > y, cmd > file)
  cleaned = cleaned.replace(/^\s*>+\s?/gm, "");
  const firstLine = cleaned
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return "";
  return firstLine.replace(/\s+/g, " ").trim();
}

function truncateAtWordBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const slice = text.slice(0, maxLength);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > maxLength * 0.5) {
    // Cut at the word boundary and keep the trailing space so the ellipsis
    // visibly follows a non-letter (signals the cut to the reader).
    return slice.slice(0, lastSpace) + " …";
  }
  return slice.slice(0, maxLength) + "…";
}

/**
 * Minimal interface describing what we use from the Anthropic SDK client.
 * Modeled this way so tests can inject a mock without instantiating the real client.
 */
export interface TitlerClient {
  messages: {
    create: (
      params: Anthropic.Messages.MessageCreateParamsNonStreaming
    ) => Promise<Anthropic.Messages.Message>;
  };
}

const SET_TITLE_TOOL_NAME = "set_session_title";
const TITLER_MODEL = "claude-haiku-4-5";
const TITLER_MAX_OUTPUT_TOKENS = 50;

const SET_TITLE_TOOL: Anthropic.Messages.Tool = {
  name: SET_TITLE_TOOL_NAME,
  description:
    "Set the display title for a coding-agent session, shown in the left sidebar. Title must be short and human-readable.",
  input_schema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: `A 3-6 word topic summary. Total length must be at most ${TARGET_TITLE_LENGTH} characters. No trailing punctuation, no quotes, no emoji.`,
      },
    },
    required: ["title"],
    additionalProperties: false,
  },
};

function buildPrefixInstruction(spawnSource: SpawnSource | string | null | undefined): string {
  switch (spawnSource) {
    case "github-bot":
      return 'Output format: "GitHub: <topic>". Replace any "PR #N" placeholder with a real topic. Comments become "GitHub: <ask>".';
    case "slack-bot":
      return 'Output format: "Slack: <topic>".';
    case "linear-bot":
      return 'Output format: "Linear: <ticket-id> – <topic>" if a ticket ID like "ABC-123" is present in the prompt; otherwise "Linear: <topic>".';
    default:
      return "Output format: just the topic, no prefix.";
  }
}

const SYSTEM_MESSAGE = `You are naming a coding-agent session for display in a left-hand sidebar.
The user prompt is the first message they sent in this session.
Pick a short topic that summarizes what the session is about — what the user wants to do, or what they want changed.
Constraints:
- Total length must be at most ${TARGET_TITLE_LENGTH} characters (hard ceiling ${MAX_TITLE_LENGTH}).
- 3 to 6 words for the topic itself.
- Sentence case is fine.
- No trailing punctuation. No quotes. No emoji.
- Do not include the user's name or repository name unless the user mentioned it explicitly in the prompt.
You must respond by calling the ${SET_TITLE_TOOL_NAME} tool.`;

interface GenerateTitleArgs {
  client: TitlerClient | null;
  prompt: string;
  spawnSource: SpawnSource | string | null | undefined;
}

function sanitizeModelTitle(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "";
  if (collapsed.length <= MAX_TITLE_LENGTH) return collapsed;
  return collapsed.slice(0, MAX_TITLE_LENGTH);
}

/**
 * Call Haiku to produce a session title. Returns null on any failure path
 * (network error, no client, malformed tool result, empty title, etc).
 */
export async function generateTitle(args: GenerateTitleArgs): Promise<string | null> {
  if (!args.client) return null;

  const userMessage = `${buildPrefixInstruction(args.spawnSource)}

User prompt:
${args.prompt}`;

  try {
    const response = await args.client.messages.create({
      model: TITLER_MODEL,
      max_tokens: TITLER_MAX_OUTPUT_TOKENS,
      temperature: 0,
      system: SYSTEM_MESSAGE,
      tools: [SET_TITLE_TOOL],
      tool_choice: {
        type: "tool",
        name: SET_TITLE_TOOL_NAME,
        disable_parallel_tool_use: true,
      },
      messages: [{ role: "user", content: userMessage }],
    });

    const toolBlock = response.content.find(
      (block): block is Anthropic.Messages.ToolUseBlock =>
        block.type === "tool_use" && block.name === SET_TITLE_TOOL_NAME
    );
    if (!toolBlock) return null;

    const input = toolBlock.input as { title?: unknown } | undefined;
    if (!input || typeof input.title !== "string") return null;

    const sanitized = sanitizeModelTitle(input.title);
    return sanitized.length > 0 ? sanitized : null;
  } catch {
    return null;
  }
}

/**
 * Build a deterministic, non-empty title from a prompt.
 * Guarantees: returns a non-empty string of at most MAX_TITLE_LENGTH characters,
 * with the appropriate source prefix for the spawnSource. If sanitization yields
 * nothing, returns the literal "Untitled session".
 */
export function derivePromptTitle(
  prompt: string,
  spawnSource: SpawnSource | string | null | undefined
): string {
  const sanitized = sanitizePromptForTitle(prompt);
  const { prefix } = getPrefixSpec(spawnSource);

  if (sanitized.length === 0) {
    return UNTITLED;
  }

  const budget = TARGET_TITLE_LENGTH - prefix.length;
  if (budget <= 0) {
    return UNTITLED;
  }

  const truncated = truncateAtWordBoundary(sanitized, budget);
  const candidate = prefix + truncated;

  if (candidate.length > MAX_TITLE_LENGTH) {
    return candidate.slice(0, MAX_TITLE_LENGTH - 1) + "…";
  }

  return candidate;
}

export interface AutoRenameDeps {
  repository: {
    getSession: () => SessionRow | null;
    updateSessionTitle: (sessionId: string, title: string, updatedAt: number) => void;
    markTitleAutoRenameAttempted: (sessionId: string, attemptedAt: number) => void;
  };
  /** Returns a non-empty title, or null on any failure (network, malformed, empty). */
  titler: (args: {
    prompt: string;
    spawnSource: SpawnSource | string | null | undefined;
  }) => Promise<string | null>;
  syncSessionIndexTitle: (publicSessionId: string, title: string) => void;
  broadcast: (message: ServerMessage) => void;
  getPublicSessionId: (session: SessionRow) => string;
  log: Logger;
  now: () => number;
}

interface RunAutoRenameArgs {
  deps: AutoRenameDeps;
  prompt: string;
}

/**
 * Background task that produces and applies an auto-generated session title.
 *
 * Invariants:
 * - title_manually_set wins. If a participant has explicitly renamed the session,
 *   no auto-rename ever overwrites them.
 * - One-shot. The marker `title_auto_rename_attempted_at` is set BEFORE the LLM
 *   call so a worker crash mid-call does not cause a second attempt on the next
 *   prompt.
 * - No nameless session. If the titler returns null AND the existing title is
 *   null/empty, we fall back to a deterministic prompt-derived title; if that
 *   also yields nothing, we write the literal "Untitled session".
 */
export async function runAutoRename({ deps, prompt }: RunAutoRenameArgs): Promise<void> {
  const session = deps.repository.getSession();
  if (!session) return;

  if (session.title_manually_set === 1) {
    deps.log.debug("auto_rename.skip", { reason: "title_manually_set", session_id: session.id });
    return;
  }
  if (session.title_auto_rename_attempted_at !== null) {
    deps.log.debug("auto_rename.skip", { reason: "already_attempted", session_id: session.id });
    return;
  }

  deps.repository.markTitleAutoRenameAttempted(session.id, deps.now());

  const haikuTitle = await deps.titler({ prompt, spawnSource: session.spawn_source });

  const fresh = deps.repository.getSession();
  if (!fresh) return;
  if (fresh.title_manually_set === 1) {
    deps.log.info("auto_rename.skip_post_call", {
      reason: "title_manually_set_during_call",
      session_id: fresh.id,
    });
    return;
  }

  const existing = fresh.title?.trim() ?? "";
  const existingIsEmpty = existing.length === 0;

  let finalTitle: string;
  if (haikuTitle && haikuTitle.trim().length > 0) {
    finalTitle = haikuTitle;
  } else if (existingIsEmpty) {
    finalTitle = derivePromptTitle(prompt, fresh.spawn_source);
  } else {
    deps.log.info("auto_rename.preserve_existing", {
      session_id: fresh.id,
      existing_title: existing,
    });
    return;
  }

  deps.repository.updateSessionTitle(fresh.id, finalTitle, deps.now());
  deps.syncSessionIndexTitle(deps.getPublicSessionId(fresh), finalTitle);
  deps.broadcast({ type: "session_title", title: finalTitle });

  deps.log.info("auto_rename.applied", {
    session_id: fresh.id,
    used_haiku: haikuTitle !== null,
    final_title: finalTitle,
  });
}
