import { z } from "zod";

export const githubLoginSchema = z
  .string()
  .trim()
  .regex(/^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/, {
    message: "Invalid GitHub login",
  });

export function formatGitHubNoreplyEmail(identity: { id: string | number; login: string }): string {
  return `${identity.id}+${identity.login}@users.noreply.github.com`;
}
