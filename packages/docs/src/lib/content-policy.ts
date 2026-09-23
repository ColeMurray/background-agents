import { pageSchema } from "fumadocs-core/source/schema";
import { z } from "zod";

/** A repository-relative, normalized source path: no absolute paths, traversal, or backslashes. */
const repositoryPath = z
  .string()
  .trim()
  .min(1)
  .refine((path) => !path.startsWith("/") && !/^[A-Za-z]:/.test(path), {
    message: "relatedCode paths must be relative to the repository root",
  })
  .refine((path) => !path.includes("\\"), {
    message: "relatedCode paths must use forward slashes",
  })
  .refine(
    (path) =>
      path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    { message: "relatedCode paths must be normalized (no empty, '.', or '..' segments)" }
  );

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
  /** A real calendar date in YYYY-MM-DD form; `2026-02-31` is rejected, not normalized. */
  lastReviewed: z.iso.date({ error: "lastReviewed must be a calendar date in YYYY-MM-DD form" }),
  /** Source files the page was verified against. Provenance is mandatory, never defaulted. */
  relatedCode: z.array(repositoryPath).min(1, {
    message: "relatedCode must name at least one repository source path",
  }),
});

export type PublicPage = z.infer<typeof publicPageSchema>;

export function parsePublicPage(input: unknown): PublicPage {
  return publicPageSchema.parse(input);
}
