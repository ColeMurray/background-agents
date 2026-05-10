/**
 * Slack Notify Tool — post a message to a Slack channel via the control plane.
 *
 * The bot token never enters the sandbox. The control plane authorizes the
 * call against the master switch + Slack-side channel membership, sanitizes
 * the text, attaches an attribution footer + View Session button, and emits
 * tool_call/tool_result events on the session transcript. This tool only
 * exists in the sandbox if the control plane installed it at spawn time
 * (AGENT_SLACK_NOTIFY_ENABLED=true) — see _install_tools in the
 * sandbox-runtime entrypoint.
 */
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { bridgeFetch, extractError } from "./_bridge-client.js";

export default tool({
  name: "slack-notify",
  description:
    "Post a message to a Slack channel that the user has authorized. Use this only when the user has explicitly asked you to notify Slack — this is an externally-visible action that other humans will see. The user must tell you which channel; do not guess. The bot must already be invited to the channel; if you get channel_not_found_or_forbidden, ask the user to invite the bot. Plain text + Slack mrkdwn formatting only (bold *...*, italic _..._, inline code `...`, fenced blocks, lists, blockquotes). The server attaches the attribution footer and View Session button — do not fabricate them.",
  args: {
    channel: z
      .string()
      .describe(
        "Target channel as either a channel ID (e.g. C01ABC) or the channel name as the user said it (e.g. ops or #ops). Passed verbatim to Slack — no resolution or lookup."
      ),
    text: z
      .string()
      .describe(
        "Message body. Plain text + Slack mrkdwn (bold *...*, italic _..._, inline code `...`, fenced blocks, lists, blockquotes). No interactive elements. Direct user mentions <@U...> are subject to the workspace's mentions policy; broadcast mentions <!channel>/<!here>/<!subteam^...> are always stripped server-side."
      ),
    thread_ts: z
      .string()
      .optional()
      .describe(
        "Optional Slack thread timestamp to reply within an existing thread. Same channel-membership rules apply."
      ),
    reason: z
      .string()
      .optional()
      .describe(
        "Optional short note explaining why you are posting. Recorded server-side for audit; not shown in Slack."
      ),
  },
  async execute(args) {
    try {
      const response = await bridgeFetch("/slack-notify", {
        method: "POST",
        body: JSON.stringify({
          channel: args.channel,
          text: args.text,
          thread_ts: args.thread_ts,
          reason: args.reason,
        }),
      });

      if (!response.ok) {
        const errorMessage = await extractError(response);

        if (response.status === 503) {
          return `Cannot post to Slack: ${errorMessage}. The deployment is not configured to send agent notifications.`;
        }
        if (response.status === 403) {
          return `Cannot post to Slack: ${errorMessage}. Agent notifications are disabled for this repository — ask the user to enable them in integration settings.`;
        }
        if (response.status === 404) {
          return `Cannot post to Slack: ${errorMessage}. The channel ${args.channel} was not found, is archived, or the bot is not in it. If the channel name is correct and not archived, ask the user to invite the bot.`;
        }
        if (response.status === 422) {
          return `Cannot post to Slack: ${errorMessage}. The message body was empty after sanitization — try again with non-empty content.`;
        }
        if (response.status === 429) {
          return `Rate limited by Slack: ${errorMessage}. Wait before retrying.`;
        }
        return `Failed to post to Slack: ${errorMessage} (HTTP ${response.status})`;
      }

      const result = await response.json();
      const lines = [`Posted to ${result.channelInput}: ${result.permalink}`];
      if (result.truncated) {
        lines.push("Note: message was truncated to fit Slack length limits.");
      }
      if (result.strippedBroadcasts) {
        lines.push("Note: broadcast mentions (@channel/@here) were stripped.");
      }
      if (result.mentionsModified) {
        lines.push("Note: direct user mentions were modified per workspace mentions policy.");
      }
      return lines.join("\n");
    } catch (error) {
      return `Failed to post to Slack: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});
