import { isCanonicalUserId } from "@open-inspect/shared";
import { z } from "zod";

export const browserAuthSessionUserSchema = z.object({
  id: z.string().refine(isCanonicalUserId, "Browser session user id is not canonical"),
  name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  image: z.string().nullable().optional(),
});

export const browserAuthSessionResponseSchema = z
  .object({
    user: browserAuthSessionUserSchema,
    session: z
      .object({
        id: z.string().min(1),
        userId: z.string().min(1),
        expiresAt: z.string().min(1),
      })
      .passthrough(),
  })
  .refine(({ session, user }) => session.userId === user.id, {
    message: "Browser session user does not match its principal",
  });

export type BrowserAuthSessionUser = z.infer<typeof browserAuthSessionUserSchema>;
export type BrowserAuthSessionResponse = z.infer<typeof browserAuthSessionResponseSchema>;
