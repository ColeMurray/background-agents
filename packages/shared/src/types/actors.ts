import { z } from "zod";

/**
 * Profile a bot attests for the actor it signs as, sent to `POST /actors/me`
 * before any other request that carries that actor. The control plane links
 * a new actor to an existing user only by the email it sees at enrollment.
 */
export const enrollActorRequestSchema = z
  .object({
    displayName: z.string().optional(),
    email: z.string().optional(),
    avatarUrl: z.string().optional(),
  })
  .strict();

/** Body of `POST /actors/me`. */
export type EnrollActorRequest = z.infer<typeof enrollActorRequestSchema>;
