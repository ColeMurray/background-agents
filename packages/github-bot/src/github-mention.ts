import { escapeRegExp } from "@open-inspect/shared/regex";

function botMentionPattern(botUsername: string, flags: string): RegExp {
  return new RegExp(`@${escapeRegExp(botUsername)}(?![A-Za-z0-9-])`, flags);
}

export function containsBotMention(body: string, botUsername: string | undefined): boolean {
  return botUsername ? botMentionPattern(botUsername, "i").test(body) : false;
}

export function stripBotMention(body: string, botUsername: string): string {
  return body.replace(botMentionPattern(botUsername, "gi"), "").trim();
}
