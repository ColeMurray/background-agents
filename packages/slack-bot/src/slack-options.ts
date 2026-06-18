import type { SlackPlainText } from "./app-home/slack-types";

/** Slack caps a select option's plain_text label/description at 75 characters. */
export const SELECT_OPTION_TEXT_LIMIT = 75;

/** Truncate option text to Slack's per-option limit, with an ellipsis when cut. */
export function truncateSelectOptionText(text: string): string {
  if (text.length <= SELECT_OPTION_TEXT_LIMIT) {
    return text;
  }

  return `${text.slice(0, SELECT_OPTION_TEXT_LIMIT - 1)}…`;
}

/** Build a plain_text object for a select option, truncated to Slack's limit. */
export function plainTextOption(text: string): SlackPlainText {
  return { type: "plain_text", text: truncateSelectOptionText(text) };
}
