/**
 * Who may submit tasks, and where.
 *
 * The Discord role is the only admission gate for this bot: anyone holding an
 * allowed role becomes a Member of the workspace on their first task. Keep the
 * role list tight.
 */

import type { GuildCommand, Interaction } from "./types";

export type AccessDecision =
  | { allowed: true; command: GuildCommand }
  | { allowed: false; reason: "not_in_guild" | "wrong_channel" | "missing_role" };

export type AccessDenial = Exclude<AccessDecision, { allowed: true }>;

export function parseIdList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

function isGuildCommand(interaction: Interaction): interaction is GuildCommand {
  return (
    interaction.guild_id !== undefined &&
    interaction.channel_id !== undefined &&
    interaction.member !== undefined
  );
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
  if (!isGuildCommand(interaction)) {
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

  return { allowed: true, command: interaction };
}

export function denialMessage(decision: AccessDenial, allowedChannelIds: string[]): string {
  switch (decision.reason) {
    case "not_in_guild":
      return "Tasks can only be submitted from the server, not from DMs.";
    case "wrong_channel":
      return `Tasks can only be submitted in ${allowedChannelIds.map((id) => `<#${id}>`).join(", ")}.`;
    case "missing_role":
      return "Your roles don't allow submitting tasks. Ask a server admin for access.";
  }
}
