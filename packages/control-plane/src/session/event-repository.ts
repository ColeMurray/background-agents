import { toolCallIdentityKey } from "@open-inspect/shared/types/sandbox-events";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import {
  eventTimelineCursorFromRow,
  type EventListCursor,
  type EventTimelineCursor,
} from "./event-cursor";
import type { SqlStorage, TransactionSync } from "./sql-storage";
import {
  EVENT_CHANGE_JOURNAL_BYTE_LIMIT,
  EVENT_CHANGE_RETENTION_LIMIT,
  EVENT_CHANGE_RETENTION_MS,
  type EventChangeRow,
  type EventRow,
} from "./types";

export {
  EVENT_CHANGE_JOURNAL_BYTE_LIMIT,
  EVENT_CHANGE_RETENTION_LIMIT,
  EVENT_CHANGE_RETENTION_MS,
} from "./types";

type TokenEvent = Extract<SandboxEvent, { type: "token" }>;
type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;
type ExecutionCompleteEvent = Extract<SandboxEvent, { type: "execution_complete" }>;
type UpsertableEventType = TokenEvent["type"] | ExecutionCompleteEvent["type"];

const NEXT_TIMELINE_SEQUENCE_SQL = "(SELECT COALESCE(MAX(timeline_sequence), 0) + 1 FROM events)";
const EVENT_CHANGE_PRUNE_BATCH_SIZE = 500;
const EVENT_CHANGE_PRUNE_INTERVAL = 32;

export interface CreateEventData {
  id: string;
  type: string;
  data: string;
  messageId: string | null;
  createdAt: number;
}

export interface ListEventPageOptions {
  cursor?: EventListCursor | null;
  limit: number;
  type?: string | null;
  messageId?: string | null;
}

export interface ListEventTimelinePageOptions {
  cursor?: EventTimelineCursor | null;
  excludeTypes?: string[];
  limit: number;
}

export interface EventPage {
  events: EventRow[];
  hasMore: boolean;
  nextCursor: EventTimelineCursor | null;
}

export type EventFeedCursor =
  | {
      mode: "snapshot";
      scope: string;
      checkpoint: number;
      createdAt: number;
      timelineSequence: number;
    }
  | {
      mode: "changes";
      scope: string;
      checkpoint: number;
      revision: number;
    };

export interface EventChangePage {
  changes: EventChangeRow[];
  checkpoint: number;
  hasMore: boolean;
  nextCursor: EventFeedCursor | null;
}

export interface ListEventChangesOptions {
  after?: number;
  cursor?: EventFeedCursor;
  limit: number;
}

interface QueryEventPageOptions extends ListEventPageOptions {
  excludeTypes?: string[];
}

export class InvalidEventFeedCursorError extends Error {}
export class EventFeedCheckpointExpiredError extends Error {}

/** Persistence for events scoped to one session. */
export class EventRepository {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transactionSync: TransactionSync
  ) {}

  private nextRevision(): number {
    return (
      this.sql
        .exec(
          `UPDATE event_feed_state
        SET current_revision = current_revision + 1
        WHERE singleton = 1
        RETURNING current_revision`
        )
        .one() as { current_revision: number }
    ).current_revision;
  }

  private appendUpsert(eventId: string, revision: number, changedAt: number): void {
    this.sql.exec(
      `INSERT INTO event_changes
       (revision, kind, event_id, type, data, message_id, created_at, timeline_sequence,
        changed_at, journal_bytes)
       SELECT ?, 'upsert', id, type, data, message_id, created_at, timeline_sequence, ?,
         64 + length(CAST(id AS BLOB)) + length(CAST(type AS BLOB))
           + length(CAST(data AS BLOB)) + COALESCE(length(CAST(message_id AS BLOB)), 0)
       FROM events WHERE id = ?`,
      revision,
      changedAt,
      eventId
    );
    this.maybePruneChanges(revision, changedAt);
  }

  private appendDelete(eventId: string, revision: number, changedAt: number): void {
    this.sql.exec(
      `INSERT INTO event_changes (revision, kind, event_id, changed_at, journal_bytes)
       VALUES (?, 'delete', ?, ?, 64 + length(CAST(? AS BLOB)))`,
      revision,
      eventId,
      changedAt,
      eventId
    );
    this.maybePruneChanges(revision, changedAt);
  }

  private maybePruneChanges(revision: number, changedAt: number): void {
    if (revision % EVENT_CHANGE_PRUNE_INTERVAL === 0) this.pruneChanges(changedAt);
  }

  private ensureCurrentVersionRecoverable(eventId: string): void {
    const mustRotate = (
      this.sql
        .exec(
          `SELECT 1 AS must_rotate FROM events, event_feed_state
           WHERE events.id = ? AND event_feed_state.singleton = 1
             AND events.change_revision <= event_feed_state.retention_floor
             AND NOT EXISTS (
               SELECT 1 FROM event_changes
               WHERE revision = events.change_revision AND event_id = events.id
                 AND is_baseline = 1
             )`,
          eventId
        )
        .toArray()[0] as { must_rotate: number } | undefined
    )?.must_rotate;
    if (mustRotate) this.rotateCursorScopeAndDeleteHistory();
  }

  private pruneChanges(now: number): void {
    const boundaries = this.sql
      .exec(
        `SELECT
           COALESCE((SELECT retention_floor FROM event_feed_state WHERE singleton = 1), 0)
             AS existing_floor,
           MAX(CASE WHEN changed_at <= ? THEN revision END) AS time_floor,
           COALESCE((SELECT current_revision FROM event_feed_state WHERE singleton = 1), 0)
             - ? AS count_floor,
           COALESCE((
             SELECT MAX(revision) FROM (
               SELECT revision,
                 SUM(journal_bytes) OVER (ORDER BY revision DESC) AS retained_bytes
               FROM event_changes
             ) WHERE retained_bytes > ?
           ), 0) AS byte_floor
         FROM event_changes`,
        now - EVENT_CHANGE_RETENTION_MS,
        EVENT_CHANGE_RETENTION_LIMIT,
        EVENT_CHANGE_JOURNAL_BYTE_LIMIT
      )
      .one() as {
      existing_floor: number;
      time_floor: number | null;
      count_floor: number;
      byte_floor: number;
    };
    const logicalBoundary = Math.max(
      boundaries.existing_floor,
      boundaries.time_floor ?? 0,
      boundaries.count_floor,
      boundaries.byte_floor
    );
    if (logicalBoundary > 0) this.compactThroughFloor(logicalBoundary);

    while (true) {
      const stats = this.sql
        .exec(
          `SELECT
             COALESCE(SUM(CASE WHEN is_baseline = 1 THEN journal_bytes ELSE 0 END), 0)
               AS baseline_bytes,
             COALESCE(SUM(CASE WHEN is_baseline = 1 THEN 1 ELSE 0 END), 0)
               AS baseline_count,
             COALESCE(SUM(journal_bytes), 0) AS total_bytes,
             COUNT(*) AS total_count
           FROM event_changes`
        )
        .one() as {
        baseline_bytes: number;
        baseline_count: number;
        total_bytes: number;
        total_count: number;
      };
      if (
        stats.baseline_bytes > EVENT_CHANGE_JOURNAL_BYTE_LIMIT ||
        stats.baseline_count > EVENT_CHANGE_RETENTION_LIMIT
      ) {
        this.rotateCursorScopeAndDeleteHistory();
        return;
      }
      if (
        stats.total_bytes <= EVENT_CHANGE_JOURNAL_BYTE_LIMIT &&
        stats.total_count <= EVENT_CHANGE_RETENTION_LIMIT
      ) {
        return;
      }
      const nextFloor = (
        this.sql
          .exec(
            `SELECT MAX(revision) AS revision FROM (
               SELECT revision,
                 SUM(journal_bytes) OVER (ORDER BY revision DESC) AS retained_bytes,
                 ROW_NUMBER() OVER (ORDER BY revision DESC) AS retained_count
               FROM event_changes WHERE is_baseline = 0
             ) WHERE retained_bytes > ? OR retained_count > ?`,
            EVENT_CHANGE_JOURNAL_BYTE_LIMIT - stats.baseline_bytes,
            EVENT_CHANGE_RETENTION_LIMIT - stats.baseline_count
          )
          .one() as { revision: number | null }
      ).revision;
      if (nextFloor === null) {
        this.rotateCursorScopeAndDeleteHistory();
        return;
      }
      this.compactThroughFloor(nextFloor);
    }
  }

  private compactThroughFloor(retentionFloor: number): void {
    this.sql.exec(
      `UPDATE event_feed_state
      SET retention_floor = MAX(retention_floor, ?)
      WHERE singleton = 1`,
      retentionFloor
    );
    this.sql.exec(`UPDATE event_changes SET is_baseline = 0 WHERE revision <= ?`, retentionFloor);
    this.sql.exec(
      `UPDATE event_changes SET is_baseline = 1
       WHERE revision IN (
         SELECT MAX(revision) FROM event_changes
         WHERE revision <= ? GROUP BY event_id
       )`,
      retentionFloor
    );
    this.sql.exec(
      `DELETE FROM event_changes
       WHERE revision <= ? AND is_baseline = 1 AND kind = 'delete'`,
      retentionFloor
    );
    this.deleteChangesThrough(retentionFloor, true);
  }

  private rotateCursorScopeAndDeleteHistory(): void {
    const currentRevision = (
      this.sql
        .exec(
          `UPDATE event_feed_state SET
          cursor_scope = lower(hex(randomblob(16))),
          retention_floor = current_revision
          WHERE singleton = 1
          RETURNING current_revision`
        )
        .one() as { current_revision: number }
    ).current_revision;
    this.deleteChangesThrough(currentRevision, false);
  }

  private deleteChangesThrough(revision: number, preserveBaselines: boolean): void {
    const baselineCondition = preserveBaselines ? "AND is_baseline = 0" : "";
    while (true) {
      const boundary = (
        this.sql
          .exec(
            `SELECT revision FROM event_changes
           WHERE revision <= ? ${baselineCondition}
           ORDER BY revision ASC LIMIT 1 OFFSET ?`,
            revision,
            EVENT_CHANGE_PRUNE_BATCH_SIZE - 1
          )
          .toArray()[0] as { revision: number } | undefined
      )?.revision;
      if (boundary === undefined) {
        this.sql.exec(
          `DELETE FROM event_changes WHERE revision <= ? ${baselineCondition}`,
          revision
        );
        return;
      }
      this.sql.exec(`DELETE FROM event_changes WHERE revision <= ? ${baselineCondition}`, boundary);
    }
  }

  createEventWithinTransaction(data: CreateEventData): void {
    const revision = this.nextRevision();
    this.sql.exec(
      `INSERT INTO events
       (id, type, data, message_id, created_at, timeline_sequence, change_revision)
       VALUES (?, ?, ?, ?, ?, ${NEXT_TIMELINE_SEQUENCE_SQL}, ?)`,
      data.id,
      data.type,
      data.data,
      data.messageId,
      data.createdAt,
      revision
    );
    this.appendUpsert(data.id, revision, Date.now());
  }

  createEvent(data: CreateEventData): void {
    this.transactionSync(() => this.createEventWithinTransaction(data));
  }

  createContextCompactionEvent(data: CreateEventData & { messageId: string }): void {
    this.transactionSync(() => {
      const oldId = `token:${data.messageId}`;
      const newId = `token:${data.messageId}:${data.id}`;
      this.ensureCurrentVersionRecoverable(oldId);
      const deleteRevision = this.nextRevision();
      const upsertRevision = this.nextRevision();
      const renamed = this.sql.exec(
        `UPDATE events SET id = ?, change_revision = ? WHERE id = ? RETURNING id`,
        newId,
        upsertRevision,
        oldId
      );
      if (renamed.toArray().length === 1) {
        const changedAt = Date.now();
        this.appendDelete(oldId, deleteRevision, changedAt);
        this.appendUpsert(newId, upsertRevision, changedAt);
      }
      this.createEventWithinTransaction(data);
    });
  }

  private upsertEventByMessageIdWithinTransaction<TType extends UpsertableEventType>(
    type: TType,
    messageId: string,
    event: Extract<SandboxEvent, { type: TType }>,
    createdAt: number
  ): void {
    const id = `${type}:${messageId}`;
    this.ensureCurrentVersionRecoverable(id);
    const revision = this.nextRevision();
    this.sql.exec(
      `INSERT INTO events
       (id, type, data, message_id, created_at, timeline_sequence, change_revision)
       VALUES (?, ?, ?, ?, ?, ${NEXT_TIMELINE_SEQUENCE_SQL}, ?)
       ON CONFLICT(id) DO UPDATE SET
          data = excluded.data,
          message_id = excluded.message_id,
          created_at = excluded.created_at,
          change_revision = excluded.change_revision`,
      id,
      type,
      JSON.stringify(event),
      messageId,
      createdAt,
      revision
    );
    this.appendUpsert(id, revision, Date.now());
  }

  upsertTokenEvent(messageId: string, event: TokenEvent, createdAt: number): void {
    this.transactionSync(() =>
      this.upsertEventByMessageIdWithinTransaction("token", messageId, event, createdAt)
    );
  }

  upsertToolCallEvent(messageId: string, event: ToolCallEvent, createdAt: number): void {
    const id = `tool_call:${toolCallIdentityKey(event)}`;
    this.transactionSync(() => {
      this.ensureCurrentVersionRecoverable(id);
      const revision = this.nextRevision();
      this.sql.exec(
        `INSERT INTO events
         (id, type, data, message_id, created_at, timeline_sequence, change_revision)
         VALUES (?, ?, ?, ?, ?, ${NEXT_TIMELINE_SEQUENCE_SQL}, ?)
         ON CONFLICT(id) DO UPDATE SET
            data = excluded.data,
            message_id = excluded.message_id,
            change_revision = excluded.change_revision`,
        id,
        event.type,
        JSON.stringify(event),
        messageId,
        createdAt,
        revision
      );
      this.appendUpsert(id, revision, Date.now());
    });
  }

  upsertExecutionCompleteEventWithinTransaction(
    messageId: string,
    event: ExecutionCompleteEvent,
    createdAt: number
  ): void {
    this.upsertEventByMessageIdWithinTransaction("execution_complete", messageId, event, createdAt);
  }

  upsertExecutionCompleteEvent(
    messageId: string,
    event: ExecutionCompleteEvent,
    createdAt: number
  ): void {
    this.transactionSync(() =>
      this.upsertExecutionCompleteEventWithinTransaction(messageId, event, createdAt)
    );
  }

  deleteEventWithinTransaction(eventId: string): boolean {
    this.ensureCurrentVersionRecoverable(eventId);
    const deleted = this.sql.exec(`DELETE FROM events WHERE id = ? RETURNING id`, eventId);
    if (deleted.toArray().length === 0) return false;
    this.appendDelete(eventId, this.nextRevision(), Date.now());
    return true;
  }

  listEventPage(options: ListEventPageOptions): EventPage {
    return this.queryEventPage(options);
  }

  getEventTimelinePage(options: ListEventTimelinePageOptions): EventPage {
    const page = this.queryEventPage(options);
    return { ...page, events: [...page.events].reverse() };
  }

  listEventChanges(options: ListEventChangesOptions): EventChangePage {
    const stateBeforePrune = options.cursor
      ? (this.sql
          .exec(
            `SELECT cursor_scope, current_revision
             FROM event_feed_state WHERE singleton = 1`
          )
          .one() as { cursor_scope: string; current_revision: number })
      : null;
    const cursorWasValid =
      stateBeforePrune !== null &&
      options.cursor !== undefined &&
      options.cursor.scope === stateBeforePrune.cursor_scope &&
      options.cursor.checkpoint <= stateBeforePrune.current_revision &&
      (options.cursor.mode !== "changes" || options.cursor.revision <= options.cursor.checkpoint);
    this.transactionSync(() => this.pruneChanges(Date.now()));
    try {
      return this.listEventChangesWithinTransaction(options);
    } catch (cause) {
      if (cursorWasValid && cause instanceof InvalidEventFeedCursorError) {
        throw new EventFeedCheckpointExpiredError("Event feed checkpoint expired");
      }
      throw cause;
    }
  }

  private listEventChangesWithinTransaction(options: ListEventChangesOptions): EventChangePage {
    const state = this.sql
      .exec(
        `SELECT cursor_scope, current_revision, retention_floor
      FROM event_feed_state WHERE singleton = 1`
      )
      .one() as {
      cursor_scope: string;
      current_revision: number;
      retention_floor: number;
    };
    const highWater = state.current_revision;
    const scope = state.cursor_scope;
    if (
      options.cursor &&
      (options.cursor.scope !== scope ||
        options.cursor.checkpoint > highWater ||
        (options.cursor.mode === "changes" && options.cursor.revision > options.cursor.checkpoint))
    ) {
      throw new InvalidEventFeedCursorError("Invalid event feed cursor");
    }
    if (options.after !== undefined && options.after > highWater) {
      throw new InvalidEventFeedCursorError("Invalid event feed checkpoint");
    }

    const checkpoint = options.cursor?.checkpoint ?? highWater;
    const mode = options.cursor?.mode ?? (options.after === undefined ? "snapshot" : "changes");
    const position = options.cursor?.mode === "changes" ? options.cursor.revision : options.after;
    if (
      (mode === "changes" && position !== undefined && position < state.retention_floor) ||
      (options.cursor?.mode === "snapshot" && checkpoint < state.retention_floor)
    ) {
      throw new EventFeedCheckpointExpiredError("Event feed checkpoint expired");
    }
    const rows =
      mode === "snapshot"
        ? this.listSnapshotChanges(checkpoint, state.retention_floor, options.cursor, options.limit)
        : this.listJournalChanges(checkpoint, options.after, options.cursor, options.limit);
    const hasMore = rows.length > options.limit;
    const changes = hasMore ? rows.slice(0, options.limit) : rows;
    const last = changes[changes.length - 1];
    return {
      changes,
      checkpoint,
      hasMore,
      nextCursor:
        hasMore && last
          ? last.kind === "upsert" && mode === "snapshot"
            ? {
                mode,
                scope,
                checkpoint,
                createdAt: last.created_at!,
                timelineSequence: last.timeline_sequence!,
              }
            : { mode: "changes", scope, checkpoint, revision: last.revision }
          : null,
    };
  }

  private listSnapshotChanges(
    checkpoint: number,
    retentionFloor: number,
    cursor: EventFeedCursor | undefined,
    limit: number
  ): EventChangeRow[] {
    const position = cursor?.mode === "snapshot" ? cursor : null;
    const condition = position
      ? `AND (change.created_at > ? OR
          (change.created_at = ? AND change.timeline_sequence > ?))`
      : "";
    const params = position
      ? [
          checkpoint,
          retentionFloor,
          checkpoint,
          position.createdAt,
          position.createdAt,
          position.timelineSequence,
          limit + 1,
        ]
      : [checkpoint, retentionFloor, checkpoint, limit + 1];
    return this.sql
      .exec(
        `WITH versions AS (
           SELECT revision, kind, event_id, type, data, message_id, created_at, timeline_sequence
           FROM event_changes WHERE revision <= ?
             AND (revision > ? OR is_baseline = 1)
           UNION
           SELECT change_revision, 'upsert', id, type, data, message_id, created_at,
                  timeline_sequence
           FROM events WHERE change_revision <= ?
         ), latest AS (
           SELECT event_id, MAX(revision) AS revision FROM versions GROUP BY event_id
         )
         SELECT change.* FROM versions AS change
         JOIN latest USING (event_id, revision)
         WHERE change.kind = 'upsert' ${condition}
         ORDER BY change.created_at ASC, change.timeline_sequence ASC LIMIT ?`,
        ...params
      )
      .toArray() as EventChangeRow[];
  }

  private listJournalChanges(
    checkpoint: number,
    after: number | undefined,
    cursor: EventFeedCursor | undefined,
    limit: number
  ): EventChangeRow[] {
    const position = cursor?.mode === "changes" ? cursor.revision : (after ?? 0);
    return this.sql
      .exec(
        `SELECT * FROM event_changes
         WHERE revision > ? AND revision <= ?
         ORDER BY revision ASC LIMIT ?`,
        position,
        checkpoint,
        limit + 1
      )
      .toArray() as EventChangeRow[];
  }

  private queryEventPage(options: QueryEventPageOptions): EventPage {
    let query = `SELECT * FROM events`;
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.type) {
      conditions.push(`type = ?`);
      params.push(options.type);
    }
    if (options.messageId) {
      conditions.push(`message_id = ?`);
      params.push(options.messageId);
    }
    if (options.excludeTypes?.length) {
      conditions.push(`type NOT IN (${options.excludeTypes.map(() => "?").join(", ")})`);
      params.push(...options.excludeTypes);
    }

    const cursor = options.cursor;
    if (cursor?.kind === "timeline") {
      if (cursor.sequence !== undefined) {
        conditions.push(`((created_at < ?) OR (created_at = ? AND timeline_sequence < ?))`);
        params.push(cursor.createdAt, cursor.createdAt, cursor.sequence);
      } else {
        conditions.push(`((created_at < ?) OR (created_at = ? AND id < ?))`);
        params.push(cursor.createdAt, cursor.createdAt, cursor.id);
      }
    } else if (cursor?.kind === "legacy") {
      conditions.push(`created_at < ?`);
      params.push(cursor.createdAt);
    }

    if (conditions.length > 0) query += ` WHERE ${conditions.join(" AND ")}`;

    const tieBreaker =
      cursor?.kind === "timeline" && cursor.sequence === undefined ? "id" : "timeline_sequence";
    query += ` ORDER BY created_at DESC, ${tieBreaker} DESC LIMIT ?`;
    params.push(options.limit + 1);

    const rows = this.sql.exec(query, ...params).toArray() as EventRow[];
    const hasMore = rows.length > options.limit;
    const events = hasMore ? rows.slice(0, options.limit) : rows;
    const nextCursor = events.length ? eventTimelineCursorFromRow(events[events.length - 1]) : null;
    return { events, hasMore, nextCursor };
  }
}
