import type { Logger } from "../../../logger";
import type { SessionRepository } from "../../repository";
import type { ParticipantRow } from "../../types";
import { z } from "zod";

const nullableOptionalString = z.string().nullable().optional();

const generateWsTokenRequestSchema = z.object({
  userId: z.string().optional(),
  scmUserId: nullableOptionalString,
  scmLogin: nullableOptionalString,
  scmName: nullableOptionalString,
  authName: nullableOptionalString,
  scmEmail: nullableOptionalString,
  scmTokenEncrypted: nullableOptionalString,
  scmRefreshTokenEncrypted: nullableOptionalString,
  scmTokenExpiresAt: z.number().nullable().optional(),
});

type GenerateWsTokenRequest = z.infer<typeof generateWsTokenRequestSchema>;

export interface WsTokenHandlerDeps {
  repository: Pick<
    SessionRepository,
    "createParticipant" | "updateParticipantCoalesce" | "updateParticipantWsToken"
  >;
  getParticipantByUserId: (userId: string) => ParticipantRow | null;
  generateId: (bytes?: number) => string;
  hashToken: (token: string) => Promise<string>;
  now: () => number;
  getLog: () => Logger;
}

export interface WsTokenHandler {
  generateWsToken: (request: Request) => Promise<Response>;
}

export function createWsTokenHandler(deps: WsTokenHandlerDeps): WsTokenHandler {
  return {
    async generateWsToken(request: Request): Promise<Response> {
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }

      const parsed = generateWsTokenRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }
      const body: GenerateWsTokenRequest = parsed.data;

      if (!body.userId) {
        return Response.json({ error: "userId is required" }, { status: 400 });
      }

      const now = deps.now();
      let participant = deps.getParticipantByUserId(body.userId);

      if (participant) {
        // Only accept client tokens if they're newer than what we have in the DB.
        // The server-side refresh may have rotated tokens, and the client could
        // be sending stale values from an old session cookie.
        const clientExpiresAt = body.scmTokenExpiresAt ?? null;
        const dbExpiresAt = participant.scm_token_expires_at;
        const clientSentAnyToken =
          body.scmTokenEncrypted != null || body.scmRefreshTokenEncrypted != null;

        const shouldUpdateTokens =
          clientSentAnyToken &&
          (dbExpiresAt == null || (clientExpiresAt != null && clientExpiresAt > dbExpiresAt));

        // If we already have a refresh token (server-side refresh may rotate it),
        // only accept an incoming refresh token when we're also accepting the
        // access token update, or when we don't have one yet.
        const shouldUpdateRefreshToken =
          body.scmRefreshTokenEncrypted != null &&
          (participant.scm_refresh_token_encrypted == null || shouldUpdateTokens);

        deps.repository.updateParticipantCoalesce(participant.id, {
          scmUserId: body.scmUserId ?? null,
          scmLogin: body.scmLogin ?? null,
          scmName: body.scmName ?? null,
          authName: body.authName ?? null,
          scmEmail: body.scmEmail ?? null,
          scmAccessTokenEncrypted: shouldUpdateTokens ? (body.scmTokenEncrypted ?? null) : null,
          scmRefreshTokenEncrypted: shouldUpdateRefreshToken
            ? (body.scmRefreshTokenEncrypted ?? null)
            : null,
          scmTokenExpiresAt: shouldUpdateTokens ? clientExpiresAt : null,
        });
      } else {
        const id = deps.generateId();
        deps.repository.createParticipant({
          id,
          userId: body.userId,
          scmUserId: body.scmUserId ?? null,
          scmLogin: body.scmLogin ?? null,
          scmName: body.scmName ?? null,
          authName: body.authName ?? null,
          scmEmail: body.scmEmail ?? null,
          scmAccessTokenEncrypted: body.scmTokenEncrypted ?? null,
          scmRefreshTokenEncrypted: body.scmRefreshTokenEncrypted ?? null,
          scmTokenExpiresAt: body.scmTokenExpiresAt ?? null,
          role: "member",
          joinedAt: now,
        });
        participant = deps.getParticipantByUserId(body.userId)!;
      }

      const plainToken = deps.generateId(32);
      const tokenHash = await deps.hashToken(plainToken);

      deps.repository.updateParticipantWsToken(participant.id, tokenHash, now);
      deps
        .getLog()
        .info("Generated WS token", { participant_id: participant.id, user_id: body.userId });

      return Response.json({
        token: plainToken,
        participantId: participant.id,
      });
    },
  };
}
