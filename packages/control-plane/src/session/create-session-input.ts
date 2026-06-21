import { createSessionRequestSchema } from "@open-inspect/shared";
import { z } from "zod";
import type { SessionIdentityFields } from "./identity";

const spawnSourceSchema = z.enum([
  "user",
  "agent",
  "automation",
  "github-bot",
  "linear-bot",
  "slack-bot",
]);

const createSessionInputSchema = createSessionRequestSchema.extend({
  userId: z.string().optional(),
  spawnSource: spawnSourceSchema.optional(),
  authProvider: z.enum(["github", "google"]).optional(),
  authUserId: z.string().optional(),
  authEmail: z.string().optional(),
  authName: z.string().optional(),
  authAvatarUrl: z.string().optional(),
  scmUserId: z.string().optional(),
  scmLogin: z.string().optional(),
  scmName: z.string().optional(),
  scmEmail: z.string().optional(),
  scmAvatarUrl: z.string().optional(),
  actorUserId: z.string().optional(),
  actorDisplayName: z.string().optional(),
  actorEmail: z.string().optional(),
  actorAvatarUrl: z.string().optional(),
  scmToken: z.string().optional(),
  scmRefreshToken: z.string().optional(),
  scmTokenExpiresAt: z.number().optional(),
});

export type CreateSessionInput = z.infer<typeof createSessionInputSchema> & SessionIdentityFields;

export type CreateSessionInputParseResult =
  | { ok: true; input: CreateSessionInput }
  | { ok: false; message: string };

function isObjectBody(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function parseCreateSessionInput(
  request: Request
): Promise<CreateSessionInputParseResult> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return { ok: false, message: "Invalid JSON body" };
  }

  if (!isObjectBody(parsed)) {
    return { ok: false, message: "JSON body must be an object" };
  }

  const result = createSessionInputSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, message: "Invalid session request body" };
  }

  return { ok: true, input: result.data };
}
