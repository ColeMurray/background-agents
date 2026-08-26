// Slack expires assistant thread status after two minutes without an update.
// Keep the refresh interval below that boundary while avoiding per-event polling.
export const SLACK_ACTIVITY_HEARTBEAT_INTERVAL_MS = 90_000;
