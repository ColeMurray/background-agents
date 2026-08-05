/**
 * Pure sanitizers for Slack `mrkdwn` text supplied by an untrusted source
 * (e.g., an agent inside a sandbox). The control plane composes these into
 * `sanitizeAgentText` before handing text to `chat.postMessage`.
 */

export type MentionPolicy = "allow" | "escape" | "strip";

export interface SanitizeOptions {
  mentionsPolicy: MentionPolicy;
  maxLength: number;
}

export interface SanitizeResult {
  text: string;
  truncated: boolean;
  strippedBroadcasts: boolean;
  mentionsModified: boolean;
}

const TRUNCATION_MARKER = "… (truncated)";

const BROADCAST_MENTION_RE = /<!(?:channel|here|everyone|subteam\^[A-Z0-9]+(?:\|[^>]*)?)>/g;
const URL_LINK_RE = /<(https?:\/\/[^|>\s]+|mailto:[^|>\s]+)(?:\|[^>]*)?>/g;
const USER_MENTION_RE = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;

export function stripBroadcastMentions(text: string): string {
  return text.replace(BROADCAST_MENTION_RE, "");
}

/**
 * Escape text for literal display inside Slack `mrkdwn`: `&`, `<`, and `>`
 * become entities, which neutralizes every control sequence (broadcast and
 * user mentions, links). For untrusted display *labels* — unlike
 * {@link sanitizeAgentText}, which preserves intentional formatting in prose.
 */
export function escapeMrkdwnText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function sanitizeLinks(text: string): string {
  return text.replace(URL_LINK_RE, "$1");
}

export function applyMentionPolicy(text: string, policy: MentionPolicy): string {
  if (policy === "allow") return text;
  if (policy === "escape") return text.replace(USER_MENTION_RE, "@$1");
  return text.replace(USER_MENTION_RE, "");
}

export function truncateForSlack(
  text: string,
  maxLength: number
): { text: string; truncated: boolean } {
  if (text.length <= maxLength) return { text, truncated: false };
  if (maxLength < TRUNCATION_MARKER.length) {
    return { text: TRUNCATION_MARKER.slice(0, maxLength), truncated: true };
  }
  return {
    text: text.slice(0, maxLength - TRUNCATION_MARKER.length) + TRUNCATION_MARKER,
    truncated: true,
  };
}

export function sanitizeAgentText(text: string, opts: SanitizeOptions): SanitizeResult {
  const afterBroadcasts = stripBroadcastMentions(text);
  const strippedBroadcasts = afterBroadcasts !== text;

  const afterLinks = sanitizeLinks(afterBroadcasts);

  const afterMentions = applyMentionPolicy(afterLinks, opts.mentionsPolicy);
  const mentionsModified = afterMentions !== afterLinks;

  const truncated = truncateForSlack(afterMentions, opts.maxLength);

  return {
    text: truncated.text,
    truncated: truncated.truncated,
    strippedBroadcasts,
    mentionsModified,
  };
}
