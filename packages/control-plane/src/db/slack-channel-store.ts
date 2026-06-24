/**
 * SlackChannelStore — D1 persistence for the slack_event watched-channel index.
 *
 * `automation_slack_channels` maps each slack_event automation to the Slack
 * channels it watches. It backs scheduler candidate selection (which automations
 * fire for an incoming channel message) and the watched-channels endpoint the
 * slack-bot polls to pre-filter messages before forwarding them.
 *
 * Kept out of AutomationStore so trigger-source-specific persistence doesn't leak
 * into the generic automation store — slack is the only source that needs a
 * dedicated index. The index is a denormalized copy of each automation's
 * `slack_channel` condition (held in trigger_config); a route writes the
 * automation row and the channel rows in one `db.batch` (via bindChannelStatements)
 * so the two can't drift apart on a partial failure.
 */

import type { AutomationRow } from "./automation-store";

export class SlackChannelStore {
  constructor(private readonly db: D1Database) {}

  /** Enabled, non-deleted slack_event automations watching a channel (indexed by channel_id). */
  async getSlackAutomationsForChannel(channelId: string): Promise<AutomationRow[]> {
    const result = await this.db
      .prepare(
        `SELECT a.* FROM automations a
         JOIN automation_slack_channels c ON c.automation_id = a.id
         WHERE c.channel_id = ? AND a.enabled = 1 AND a.deleted_at IS NULL
           AND a.trigger_type = 'slack_event'`
      )
      .bind(channelId)
      .all<AutomationRow>();
    return result.results || [];
  }

  /** Distinct channel IDs watched by any enabled slack_event automation. */
  async getWatchedSlackChannels(): Promise<string[]> {
    const result = await this.db
      .prepare(
        `SELECT DISTINCT c.channel_id FROM automation_slack_channels c
         JOIN automations a ON a.id = c.automation_id
         WHERE a.enabled = 1 AND a.deleted_at IS NULL AND a.trigger_type = 'slack_event'`
      )
      .all<{ channel_id: string }>();
    return (result.results || []).map((r) => r.channel_id);
  }

  /**
   * Statements that replace an automation's watched-channel set (DELETE + re-INSERT).
   * Public so a route can compose them with the automation insert/update into one
   * `db.batch`, keeping the canonical trigger_config and this index atomic.
   */
  bindChannelStatements(automationId: string, channelIds: string[]): D1PreparedStatement[] {
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare("DELETE FROM automation_slack_channels WHERE automation_id = ?")
        .bind(automationId),
    ];
    for (const channelId of channelIds) {
      statements.push(
        this.db
          .prepare(
            "INSERT OR IGNORE INTO automation_slack_channels (automation_id, channel_id) VALUES (?, ?)"
          )
          .bind(automationId, channelId)
      );
    }
    return statements;
  }

  /** Replace an automation's watched-channel set atomically. */
  async setSlackChannels(automationId: string, channelIds: string[]): Promise<void> {
    await this.db.batch(this.bindChannelStatements(automationId, channelIds));
  }
}
