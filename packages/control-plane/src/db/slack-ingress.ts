import type { SlackIngressAdmit } from "@open-inspect/shared";
import type { SqlDatabase } from "./sql-database";

export interface SlackIngressRow {
  id: string;
  source: string;
  external_event_id: string;
  payload_json: string | null;
  payload_ref: string | null;
  payload_sha256: string;
  actor_user_id: string | null;
  owner_team_id: string | null;
  channel_id: string;
  thread_ts: string | null;
  state: string;
  stable_session_id: string;
  stable_message_id: string;
  session_id: string | null;
  attempts: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  deadline_at: number;
  last_error_code: string | null;
  received_at: number;
  updated_at: number;
  terminal_at: number | null;
}
const TERMINAL = new Set(["completed", "failed"]);
export class SlackIngressStore {
  constructor(private readonly db: SqlDatabase) {}
  async admit(
    input: SlackIngressAdmit,
    now: number
  ): Promise<{ row: SlackIngressRow; created: boolean }> {
    if (input.payloadJson !== undefined) {
      const bytes = new TextEncoder().encode(input.payloadJson);
      if (bytes.byteLength > 262_144) throw new Error("Slack ingress payload is too large");
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      if (digest !== input.payloadSha256) throw new Error("Slack ingress payload hash mismatch");
    }
    const eventDigest = [
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(`${input.source}\0${input.externalEventId}`)
        )
      ),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const id = `slack_ingress_${eventDigest.slice(0, 24)}`;
    const inserted = await this.db
      .prepare(
        `INSERT INTO slack_ingress_receipts
      (id,source,external_event_id,payload_json,payload_ref,payload_sha256,actor_user_id,owner_team_id,channel_id,thread_ts,state,stable_session_id,stable_message_id,deadline_at,received_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'admitted',?,?,?,?,?) ON CONFLICT(source,external_event_id) DO NOTHING`
      )
      .bind(
        id,
        input.source,
        input.externalEventId,
        input.payloadJson ?? null,
        input.payloadRef ?? null,
        input.payloadSha256,
        input.actorUserId ?? null,
        input.ownerTeamId ?? null,
        input.channelId,
        input.threadTs ?? null,
        input.stableSessionId,
        input.stableMessageId,
        input.deadlineAt,
        now,
        now
      )
      .run();
    const row = await this.getByExternal(input.source, input.externalEventId);
    if (
      !row ||
      row.payload_sha256 !== input.payloadSha256 ||
      row.stable_session_id !== input.stableSessionId ||
      row.stable_message_id !== input.stableMessageId
    )
      throw new Error("Slack ingress idempotency conflict");
    return { row, created: inserted.meta.changes === 1 };
  }
  get(id: string) {
    return this.db
      .prepare("SELECT * FROM slack_ingress_receipts WHERE id=?")
      .bind(id)
      .first<SlackIngressRow>();
  }
  getByExternal(source: string, eventId: string) {
    return this.db
      .prepare("SELECT * FROM slack_ingress_receipts WHERE source=? AND external_event_id=?")
      .bind(source, eventId)
      .first<SlackIngressRow>();
  }
  async claim(id: string, owner: string, leaseMs: number, now: number) {
    return this.db
      .prepare(
        `UPDATE slack_ingress_receipts SET state=CASE WHEN state='admitted' THEN 'processing' ELSE state END,lease_owner=?,lease_expires_at=?,attempts=attempts+1,updated_at=?
      WHERE id=? AND deadline_at>? AND state NOT IN ('completed','failed') AND (lease_owner IS NULL OR lease_expires_at<=?) RETURNING *`
      )
      .bind(owner, now + leaseMs, now, id, now, now)
      .first<SlackIngressRow>();
  }
  async transition(
    id: string,
    owner: string,
    expected: string,
    next: string,
    sessionId: string | undefined,
    errorCode: string | undefined,
    now: number
  ) {
    if (TERMINAL.has(expected)) return null;
    const allowed: Record<string, readonly string[]> = {
      processing: ["admitted", "session_created", "completed", "failed"],
      session_created: ["prompt_queued", "failed"],
      prompt_queued: ["completed", "failed"],
    };
    if (!allowed[expected]?.includes(next)) return null;
    const releasesLease = next === "admitted" || TERMINAL.has(next);
    return this.db
      .prepare(
        `UPDATE slack_ingress_receipts SET state=?,session_id=COALESCE(?,session_id),last_error_code=?,lease_owner=CASE WHEN ? IS NULL THEN lease_owner ELSE NULL END,lease_expires_at=CASE WHEN ? IS NULL THEN lease_expires_at ELSE NULL END,updated_at=?,terminal_at=?
      WHERE id=? AND state=? AND lease_owner=? RETURNING *`
      )
      .bind(
        next,
        sessionId ?? null,
        errorCode ?? null,
        releasesLease ? now : null,
        releasesLease ? now : null,
        now,
        TERMINAL.has(next) ? now : null,
        id,
        expected,
        owner
      )
      .first<SlackIngressRow>();
  }
  async reconcile(now: number) {
    return this.db
      .prepare(
        "UPDATE slack_ingress_receipts SET lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE state NOT IN ('completed','failed') AND lease_expires_at<=?"
      )
      .bind(now, now)
      .run();
  }
  async cleanup(before: number, limit = 500): Promise<number> {
    const rows = await this.db
      .prepare(
        "SELECT id FROM slack_ingress_receipts WHERE terminal_at IS NOT NULL AND terminal_at<? ORDER BY terminal_at,id LIMIT ?"
      )
      .bind(before, limit)
      .all<{ id: string }>();
    if (rows.results.length === 0) return 0;
    const results = await this.db.batch(
      rows.results.map(({ id }) =>
        this.db
          .prepare("DELETE FROM slack_ingress_receipts WHERE id=? AND terminal_at<?")
          .bind(id, before)
      )
    );
    return results.reduce((total, result) => total + result.meta.changes, 0);
  }
}
