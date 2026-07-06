import { z } from "zod";

export const githubEmailSchema = z.object({
  email: z.string(),
  primary: z.boolean(),
  verified: z.boolean(),
  visibility: z.string().nullable(),
});

export const githubEmailListSchema = z.array(githubEmailSchema);

export type GitHubEmail = z.infer<typeof githubEmailSchema>;
