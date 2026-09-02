import type { SqlStorage } from "./sql-storage";
import {
  clientCapabilitySchema,
  type ClientCapability,
} from "@open-inspect/shared/types/websocket";

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
  capabilities?: string;
  /** Wall-clock time when the persisted authorization lease expires. */
  authorization_expires_at: number;
}

/** Data for a WS client mapping. */
export interface WsClientMappingData {
  wsId: string;
  participantId: string;
  clientId: string;
  createdAt: number;
  capabilities?: ClientCapability[];
  /** Wall-clock time when the persisted authorization lease expires. */
  authorizationExpiresAt: number;
}

/** Persistence for WebSocket client mappings scoped to one session. */
export class WsClientMappingRepository {
  constructor(private readonly sql: SqlStorage) {}

  /** Persist a client mapping and its authorization expiration. */
  upsertWsClientMapping(data: WsClientMappingData): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO ws_client_mapping
         (ws_id, participant_id, client_id, capabilities, created_at, authorization_expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      data.wsId,
      data.participantId,
      data.clientId,
      JSON.stringify(data.capabilities ?? []),
      data.createdAt,
      data.authorizationExpiresAt
    );
  }

  /** Load client identity and authorization expiration for hibernation recovery. */
  getWsClientMapping(wsId: string): WsClientMappingResult | null {
    // Keep this indexed JOIN in one query: both tables share the session-local store,
    // and this read is on the hibernation-recovery hot path.
    const result = this.sql.exec(
      `SELECT m.participant_id, m.client_id, m.capabilities, m.authorization_expires_at,
              p.user_id, p.canonical_user_id, p.scm_name, p.scm_login
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

  /** Delete one persisted client mapping. */
  deleteWsClientMapping(wsId: string): void {
    this.sql.exec(`DELETE FROM ws_client_mapping WHERE ws_id = ?`, wsId);
  }

  /** Delete all authorization mappings expired at or before the given time. */
  deleteExpiredMappings(now: number): void {
    this.sql.exec(`DELETE FROM ws_client_mapping WHERE authorization_expires_at <= ?`, now);
  }

  /** Return the earliest persisted authorization expiration, if any. */
  getNextAuthorizationExpiry(): number | null {
    const rows = this.sql
      .exec(`SELECT MIN(authorization_expires_at) AS expires_at FROM ws_client_mapping`)
      .toArray() as Array<{ expires_at: number | null }>;
    return rows[0]?.expires_at ?? null;
  }
}

/** Decode a persisted capabilities column; malformed or unknown entries are dropped. */
export function parseClientCapabilities(raw: string | null | undefined): ClientCapability[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      const result = clientCapabilitySchema.safeParse(entry);
      return result.success ? [result.data] : [];
    });
  } catch {
    return [];
  }
}
