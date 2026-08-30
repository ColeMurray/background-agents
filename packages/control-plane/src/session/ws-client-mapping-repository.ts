import { z } from "zod";
import type { SqlStorage } from "./sql-storage";

/** WS client mapping result for hibernation recovery. */
const wsClientMappingResultSchema = z.object({
  participant_id: z.string(),
  client_id: z.string(),
  user_id: z.string(),
  canonical_user_id: z.string().nullable().optional(),
  scm_name: z.string().nullable(),
  scm_login: z.string().nullable(),
  auth_name: z.string().nullable().optional(),
});

export type WsClientMappingResult = z.infer<typeof wsClientMappingResultSchema>;

/** Data for a WS client mapping. */
export interface WsClientMappingData {
  wsId: string;
  participantId: string;
  clientId: string;
  createdAt: number;
}

/** Persistence for WebSocket client mappings scoped to one session. */
export class WsClientMappingRepository {
  constructor(private readonly sql: SqlStorage) {}

  upsertWsClientMapping(data: WsClientMappingData): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO ws_client_mapping (ws_id, participant_id, client_id, created_at)
       VALUES (?, ?, ?, ?)`,
      data.wsId,
      data.participantId,
      data.clientId,
      data.createdAt
    );
  }

  getWsClientMapping(wsId: string): WsClientMappingResult | null {
    // Keep this indexed JOIN in one query: both tables share the session-local store,
    // and this read is on the hibernation-recovery hot path.
    const result = this.sql.exec(
      `SELECT m.participant_id, m.client_id, p.user_id, p.canonical_user_id, p.scm_name, p.scm_login
       FROM ws_client_mapping m
       JOIN participants p ON m.participant_id = p.id
       WHERE m.ws_id = ?`,
      wsId
    );
    const parsed = wsClientMappingResultSchema.safeParse(result.toArray()[0]);
    return parsed.success ? parsed.data : null;
  }

  hasWsClientMapping(wsId: string): boolean {
    const result = this.sql.exec(
      `SELECT participant_id FROM ws_client_mapping WHERE ws_id = ?`,
      wsId
    );
    return result.toArray().length > 0;
  }
}
