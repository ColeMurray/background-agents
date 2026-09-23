/**
 * Who may submit tasks, and where.
 *
 * The Discord role is the only admission gate for this bot: anyone holding an
 * allowed role becomes a Member of the workspace on their first task. Keep the
 * role list tight.
 */

import type { Interaction } from "./types";

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; reason: "not_in_guild" | "wrong_channel" | "missing_role" };

export function parseIdList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/**
 * A command is accepted when it comes from a server member holding one of the
 * allowed roles, in an allowed channel or a thread under one. An empty channel
 * list accepts any channel; an empty role list accepts no one, so a missing
 * setting fails closed.
 */
export function checkAccess(
  interaction: Interaction,
  config: { allowedRoleIds: string[]; allowedChannelIds: string[] }
): AccessDecision {
  if (!interaction.guild_id || !interaction.member) {
    return { allowed: false, reason: "not_in_guild" };
  }

  if (config.allowedChannelIds.length > 0) {
    const channelIds = [interaction.channel_id, interaction.channel?.parent_id].filter(
      (id): id is string => typeof id === "string"
    );
    if (!channelIds.some((id) => config.allowedChannelIds.includes(id))) {
      return { allowed: false, reason: "wrong_channel" };
    }
  }

  if (!interaction.member.roles.some((role) => config.allowedRoleIds.includes(role))) {
    return { allowed: false, reason: "missing_role" };
  }

  return { allowed: true };
}

export function denialMessage(
  decision: Exclude<AccessDecision, { allowed: true }>,
  allowedChannelIds: string[]
): string {
  switch (decision.reason) {
    case "not_in_guild":
      return "Tasks can only be submitted from the server, not from DMs.";
    case "wrong_channel":
      return `Tasks can only be submitted in ${allowedChannelIds.map((id) => `<#${id}>`).join(", ")}.`;
    case "missing_role":
      return "You need the dev role to submit tasks.";
  }
}
