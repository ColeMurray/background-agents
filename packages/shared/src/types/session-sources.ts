import { z } from "zod";

/** Dependency leaf: team and session wire schemas both consume spawn sources. */
export const spawnSourceSchema = z.enum([
  "user",
  "agent",
  "automation",
  "github-bot",
  "linear-bot",
  "slack-bot",
  "discord-bot",
]);
export type SpawnSource = z.infer<typeof spawnSourceSchema>;
