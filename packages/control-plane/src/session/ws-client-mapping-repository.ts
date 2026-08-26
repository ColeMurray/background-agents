import type { SqlStorage } from "./sql-storage";

/** WS client mapping result for hibernation recovery. */
export interface WsClientMappingResult {
  participant_id: string;
  client_id: string;
  user_id: string;
  canonical_user_id?: string | null;
  scm_name: string | null;
  scm_login: string | null;
  /** Dormant legacy column may still be present on older mapping fixtures. */
  auth_name?: string | null;
}

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
    return (result.toArray() as WsClientMappingResult[])[0] ?? null;
  }

  hasWsClientMapping(wsId: string): boolean {
    const result = this.sql.exec(
      `SELECT participant_id FROM ws_client_mapping WHERE ws_id = ?`,
      wsId
    );
    return result.toArray().length > 0;
  }
}
