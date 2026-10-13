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

const BROADCAST_MENTION_RE = /<!(?:channel|here|everyone|subteam\^[A-Za-z0-9]+)(?:\|[^>]*)?>/g;
const URL_LINK_RE = /<(https?:\/\/[^|>\s]+|mailto:[^|>\s]+)(?:\|[^>]*)?>/g;
const USER_MENTION_RE = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;

/**
 * Remove Slack broadcast tokens, including labelled forms (`<!here|here>`). Repeats
 * until nothing changes: removing one token can join its neighbours into a new one
 * (`<!<!here>here>` becomes `<!here>` after a single pass).
 */
export function stripBroadcastMentions(text: string): string {
  let current = text;
  for (;;) {
    const next = current.replace(BROADCAST_MENTION_RE, "");
    if (next === current) return current;
    current = next;
  }
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
  let current = text;
  let strippedBroadcasts = false;
  let mentionsModified = false;

  // Repeat until nothing changes: each removal can join its neighbours into a new
  // token of another kind (`<!<@U1>here>` becomes `<!here>`, `<@<!here>U1>` becomes
  // `<@U1>`). Every step only shortens the text, so this terminates.
  for (;;) {
    const afterLinks = sanitizeLinks(current);
    const afterMentions = applyMentionPolicy(afterLinks, opts.mentionsPolicy);
    const afterBroadcasts = stripBroadcastMentions(afterMentions);
    mentionsModified ||= afterMentions !== afterLinks;
    strippedBroadcasts ||= afterBroadcasts !== afterMentions;
    if (afterBroadcasts === current) break;
    current = afterBroadcasts;
  }

  const truncated = truncateForSlack(current, opts.maxLength);

  return {
    text: truncated.text,
    truncated: truncated.truncated,
    strippedBroadcasts,
    mentionsModified,
  };
}
