import type { Logger } from "../../../logger";
import type { ParticipantRepository } from "../../participant-repository";
import { sessionScmDisplayFieldsSchema } from "../../contracts";
import { z } from "zod";

const nullableOptionalString = z.string().nullable().optional();

const generateWsTokenRequestSchema = sessionScmDisplayFieldsSchema.extend({
  userId: z.string().optional(),
  canonicalUserId: z.string().min(1),
  scmUserId: nullableOptionalString,
});

type GenerateWsTokenRequest = z.infer<typeof generateWsTokenRequestSchema>;

/**
 * HTTP boundary for WS-token minting: upserts the requesting participant and
 * rotates their WebSocket token. OAuth grants are held only by Better Auth.
 */
export class WsTokenHandler {
  constructor(
    private readonly repository: ParticipantRepository,
    private readonly generateId: (bytes?: number) => string,
    private readonly hashToken: (token: string) => Promise<string>,
    private readonly now: () => number = Date.now
  ) {}

  /** Mint a token for a participant bound to the authenticated canonical user. */
  async generateWsToken(request: Request, log: Logger): Promise<Response> {
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

    const now = this.now();
    let participant = this.repository.getParticipantByUserId(body.userId);

    if (participant) {
      this.repository.updateParticipantCoalesce(participant.id, {
        canonicalUserId: body.canonicalUserId,
        scmUserId: body.scmUserId ?? null,
        scmLogin: body.scmLogin ?? null,
        scmName: body.scmName ?? null,
        scmEmail: body.scmEmail ?? null,
      });
    } else {
      const id = this.generateId();
      this.repository.createParticipant({
        id,
        userId: body.userId,
        canonicalUserId: body.canonicalUserId,
        scmUserId: body.scmUserId ?? null,
        scmLogin: body.scmLogin ?? null,
        scmName: body.scmName ?? null,
        scmEmail: body.scmEmail ?? null,
        role: "member",
        joinedAt: now,
      });
      participant = this.repository.getParticipantByUserId(body.userId)!;
    }

    const plainToken = this.generateId(32);
    const tokenHash = await this.hashToken(plainToken);

    this.repository.updateParticipantWsToken(participant.id, tokenHash, now);
    log.info("Generated WS token", { participant_id: participant.id, user_id: body.userId });

    return Response.json({
      token: plainToken,
      participantId: participant.id,
    });
  }
}
