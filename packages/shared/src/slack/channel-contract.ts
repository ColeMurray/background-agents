import { z } from "zod";

/** Normalized channel for the automation channel picker. */
export const slackChannelListingSchema = z.object({
  id: z.string(),
  name: z.string(),
  isPrivate: z.boolean(),
  /** Whether the bot is a member: only member channels deliver messages. */
  isMember: z.boolean(),
});

export const controlPlaneSlackChannelsResponseSchema = z.object({
  channels: z.array(slackChannelListingSchema),
  error: z.string().optional(),
});

export type SlackChannelListing = z.infer<typeof slackChannelListingSchema>;
export type ControlPlaneSlackChannelsResponse = z.infer<
  typeof controlPlaneSlackChannelsResponseSchema
>;
