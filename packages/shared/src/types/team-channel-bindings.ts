import { z } from "zod";

export const teamChannelBindingProviderSchema = z.enum(["slack", "linear"]);
export const teamChannelBindingKindSchema = z.enum(["primary", "source"]);

export const teamChannelBindingSchema = z.strictObject({
  provider: teamChannelBindingProviderSchema,
  externalId: z.string().min(1),
  teamId: z.string().min(1),
  kind: teamChannelBindingKindSchema,
});

export const putTeamChannelBindingRequestSchema = z.strictObject({
  kind: teamChannelBindingKindSchema,
});

export const teamChannelBindingResponseSchema = z.strictObject({
  binding: teamChannelBindingSchema,
});

export const teamChannelBindingsResponseSchema = z.strictObject({
  bindings: z.array(teamChannelBindingSchema),
});

/** Bot lookup deliberately exposes no Team metadata beyond its binding scope. */
export const channelBindingResponseSchema = z.union([
  z.strictObject({ teamId: z.null() }),
  z.strictObject({ teamId: z.string().min(1), kind: teamChannelBindingKindSchema }),
]);

export type TeamChannelBindingProvider = z.infer<typeof teamChannelBindingProviderSchema>;
export type TeamChannelBindingKind = z.infer<typeof teamChannelBindingKindSchema>;
export type TeamChannelBinding = z.infer<typeof teamChannelBindingSchema>;
export type PutTeamChannelBindingRequest = z.infer<typeof putTeamChannelBindingRequestSchema>;
export type TeamChannelBindingResponse = z.infer<typeof teamChannelBindingResponseSchema>;
export type TeamChannelBindingsResponse = z.infer<typeof teamChannelBindingsResponseSchema>;
export type ChannelBindingResponse = z.infer<typeof channelBindingResponseSchema>;
