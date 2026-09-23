/**
 * Type definitions for the Discord bot.
 */

import type { ControlPlaneFetcher } from "@open-inspect/shared/service-auth";
import { z } from "zod";

/**
 * Cloudflare Worker environment bindings.
 */
export interface Env {
  // Thread-to-session mapping and the repository list cache
  DISCORD_KV: KVNamespace;

  // Service binding to control plane
  CONTROL_PLANE: ControlPlaneFetcher;

  // Environment variables
  DEPLOYMENT_NAME: string;
  WEB_APP_URL: string;
  DEFAULT_MODEL: string;
  /** Harness for sessions started from Discord: "claude" (default) or "opencode". */
  HARNESS?: string;
  APP_NAME?: string;

  // Discord application
  DISCORD_APPLICATION_ID: string;
  /** Hex-encoded Ed25519 key that signs every interaction Discord sends. */
  DISCORD_PUBLIC_KEY: string;
  /** Comma-separated role IDs; a member needs at least one to submit tasks. */
  DISCORD_ALLOWED_ROLE_IDS: string;
  /** Comma-separated channel IDs where `/task` is accepted; empty accepts any channel. */
  DISCORD_ALLOWED_CHANNEL_IDS?: string;

  // Secrets
  DISCORD_BOT_TOKEN: string;
  SERVICE_AUTH_SECRET?: string; // Per-service sig1 signing secret; also verifies CP callbacks
  LOG_LEVEL?: string;
}

// ─── Discord interaction payloads ───────────────────────────────────────────
// Only the fields the bot reads; Discord sends many more.

export const InteractionType = {
  Ping: 1,
  ApplicationCommand: 2,
  Autocomplete: 4,
} as const;

export const InteractionResponseType = {
  Pong: 1,
  ChannelMessageWithSource: 4,
  DeferredChannelMessageWithSource: 5,
  AutocompleteResult: 8,
} as const;

/** Message flag that shows a reply only to the user who invoked the command. */
export const EPHEMERAL_FLAG = 1 << 6;

const discordUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  global_name: z.string().nullable().optional(),
});

const commandOptionSchema = z.object({
  name: z.string(),
  type: z.number(),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  focused: z.boolean().optional(),
});

export type CommandOption = z.infer<typeof commandOptionSchema>;

export const interactionSchema = z.object({
  id: z.string(),
  application_id: z.string(),
  type: z.number(),
  token: z.string(),
  guild_id: z.string().optional(),
  channel_id: z.string().optional(),
  /** Partial channel; `parent_id` is set when the command runs inside a thread. */
  channel: z
    .object({
      id: z.string(),
      type: z.number().optional(),
      parent_id: z.string().nullable().optional(),
    })
    .optional(),
  member: z
    .object({
      user: discordUserSchema,
      nick: z.string().nullable().optional(),
      roles: z.array(z.string()),
    })
    .optional(),
  data: z
    .object({
      name: z.string(),
      options: z.array(commandOptionSchema).optional(),
    })
    .optional(),
});

export type Interaction = z.infer<typeof interactionSchema>;

// ─── KV records ──────────────────────────────────────────────────────────────

/** The session a task thread belongs to, so `/task` inside it sends a follow-up. */
export const threadSessionSchema = z.object({
  sessionId: z.string(),
  repoFullName: z.string(),
  model: z.string(),
  createdAt: z.number(),
});

export type ThreadSession = z.infer<typeof threadSessionSchema>;
