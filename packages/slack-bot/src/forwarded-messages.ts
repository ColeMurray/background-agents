/**
 * Recover the content of Slack messages that were shared (forwarded) into a
 * message the bot handles.
 *
 * Forwarding a message does not put its body in the new message's `text` —
 * `text` holds only whatever the user typed alongside it ("take a look at
 * this"). The shared message arrives as a *message attachment* flagged
 * `is_share`/`is_msg_unfurl`, carrying its own author, source channel,
 * permalink, body, and any files it had. Reading only `text` therefore hands
 * the agent a bare pronoun and drops the thing the user was pointing at.
 *
 * Everything the attachment carries is recovered: the body and its links are
 * quoted verbatim, images flow into the same session-attachment path as
 * directly attached ones, and the permalink plus channel id and message ts go
 * into the prompt so an agent with Slack tooling can pull the full thread.
 *
 * Link unfurls land in the same `attachments` array but are skipped: they
 * restate a page the message text already links to, and their `text` is usually
 * boilerplate ("Monitor your errors") rather than content.
 */

import type { SlackMessageAttachment, SlackMessageFile } from "@open-inspect/shared";

/** Shared messages beyond this many are dropped from the prompt. */
const MAX_FORWARDED_MESSAGES = 10;

/** Longest body kept per shared message, to bound one forward's prompt cost. */
const MAX_FORWARDED_BODY_LENGTH = 4000;

/** Counted against MAX_FORWARDED_BODY_LENGTH, not appended past it. */
const TRUNCATION_MARKER = "… [truncated]";

/** Prompt body used when a message forwards content but carries no text. */
export const FORWARD_ONLY_PROMPT_TEXT = "See the forwarded Slack message(s).";

/** Stand-in body for a shared message that was images only. */
const NO_TEXT_BODY = "(no text)";

export interface ForwardedMessages {
  /** One quoted entry per shared message, for the prompt's context block. */
  entries: string[];
  /**
   * Files the shared messages carried, in Slack's `SlackMessageFile` shape.
   * They are Slack-hosted like any other message file, so they go through the
   * same image normalization, download, and upload path.
   */
  files: SlackMessageFile[];
}

/**
 * Collect the shared messages carried by `attachments`, in the order Slack
 * listed them. Returns empty collections when the message forwarded nothing —
 * the common case, since most messages carry no attachments at all.
 */
export function collectForwardedMessages(
  attachments: SlackMessageAttachment[] | undefined
): ForwardedMessages {
  const result: ForwardedMessages = { entries: [], files: [] };
  if (!attachments?.length) return result;
  for (const attachment of attachments) {
    if (!attachment.is_share && !attachment.is_msg_unfurl) continue;
    // `fallback` is Slack's own plain-text rendering ("[date] user: body"); it
    // is the only body left when the shared message put its content somewhere
    // `text` does not reach, such as a bot post's own attachments. A `text` of
    // pure whitespace counts as absent, or it would shadow that fallback.
    const body = attachment.text?.trim() || attachment.fallback?.trim() || "";
    const files = attachment.files ?? [];
    if (!body && files.length === 0) continue;
    result.entries.push(formatEntry(attachment, body || NO_TEXT_BODY));
    result.files.push(...files);
    if (result.entries.length === MAX_FORWARDED_MESSAGES) break;
  }
  return result;
}

/**
 * Render one shared message as an attributed, sourced quote. Slack omits
 * `channel_name` unless the bot can see the source channel, and `author_name`
 * on some app posts, so the header degrades to "[Forwarded message]" — the
 * `Source` line still carries the ids an agent needs to fetch the original
 * thread through Slack tooling.
 */
function formatEntry(attachment: SlackMessageAttachment, body: string): string {
  const header = ["Forwarded message"];
  if (attachment.author_name) header.push(`from ${attachment.author_name}`);
  if (attachment.channel_name) header.push(`in #${attachment.channel_name}`);
  const source = [
    attachment.from_url,
    attachment.channel_id ? `Slack channel ${attachment.channel_id}` : undefined,
    attachment.ts ? `message ts ${attachment.ts}` : undefined,
  ].filter(Boolean);
  const lines = [`[${header.join(" ")}]`];
  if (source.length > 0) lines.push(`Source: ${source.join(" — ")}`);
  lines.push(truncate(body));
  return lines.join("\n");
}

function truncate(body: string): string {
  return body.length > MAX_FORWARDED_BODY_LENGTH
    ? `${body.slice(0, MAX_FORWARDED_BODY_LENGTH - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`
    : body;
}
