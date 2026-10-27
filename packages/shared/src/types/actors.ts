import { z } from "zod";

/**
 * Profile a bot attests for the actor it signs as. It is the body of
 * `POST /actors/me`, which a bot sends before any other request that carries
 * that actor, and the claim set control-plane admission applies to an actor:
 * a new actor links to an existing user only by the email it sees here.
 */
export const actorProfileClaimsSchema = z
  .object({
    displayName: z.string().optional(),
    email: z.string().optional(),
    avatarUrl: z.string().optional(),
  })
  .strict();

export type ActorProfileClaims = z.infer<typeof actorProfileClaimsSchema>;
