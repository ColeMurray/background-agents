import { pageSchema } from "fumadocs-core/source/schema";
import { z } from "zod";

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

export const publicPageSchema = pageSchema.extend({
  description: z.string().trim().min(1),
  audience: z.enum(["user", "team-owner", "admin", "operator", "contributor"]),
  owner: z.enum([
    "control-plane",
    "web",
    "sandbox-runtime",
    "integrations",
    "security",
    "platform",
  ]),
  status: z.literal("published"),
  lastReviewed: z.string().regex(isoDate, "lastReviewed must use YYYY-MM-DD"),
  relatedCode: z.array(z.string().trim().min(1)).default([]),
});

export type PublicPage = z.infer<typeof publicPageSchema>;

export function parsePublicPage(input: unknown): PublicPage {
  return publicPageSchema.parse(input);
}
