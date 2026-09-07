import { z } from "zod";
import type { Env } from "../types";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const provider = z.enum(["modal", "daytona", "e2b", "vercel", "opencomputer"]);
const baseReleaseSchema = z.object({
  schemaVersion: z.literal(1),
  baseReleaseId: digest,
  artifact: z.object({ provider, scope: z.string().min(1), reference: z.string().min(1) }),
  identity: z.object({
    recipeDigest: digest,
    inventoryDigest: digest,
    target: provider,
    runtimeVersion: z.string().regex(/^v\d+/),
  }),
});
export type BaseRelease = z.infer<typeof baseReleaseSchema>;

/** Selected deployment metadata, separate from runtime-reported evidence. */
export function selectedBaseRelease(
  env: Env,
  target: z.infer<typeof provider>
): BaseRelease | undefined {
  if (!env.SANDBOX_BASE_RELEASES) return undefined;
  const entries = z
    .partialRecord(provider, baseReleaseSchema)
    .parse(JSON.parse(env.SANDBOX_BASE_RELEASES));
  const selected = entries[target];
  if (selected && (selected.artifact.provider !== target || selected.identity.target !== target)) {
    throw new Error("Selected sandbox release target mismatch");
  }
  return selected;
}
