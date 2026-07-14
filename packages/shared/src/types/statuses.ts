import { z } from "zod";

// Session states
export const sessionStatusSchema = z.enum([
  "created",
  "active",
  "completed",
  "failed",
  "archived",
  "cancelled",
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type SandboxStatus =
  | "pending"
  | "spawning"
  | "connecting"
  | "warming"
  | "syncing"
  | "ready"
  | "running"
  | "stale"
  | "snapshotting"
  | "stopped"
  | "failed";
export type GitSyncStatus = "pending" | "in_progress" | "completed" | "failed";
export type MessageStatus = "pending" | "processing" | "completed" | "failed";
export type MessageSource = "web" | "slack" | "linear" | "extension" | "github" | "automation";
export type ArtifactType = "pr" | "screenshot" | "video" | "preview" | "branch";
export type EventType = z.infer<typeof eventTypeSchema>;
export type ParticipantRole = "owner" | "member";
export type SpawnSource =
  | "user"
  | "agent"
  | "automation"
  | "github-bot"
  | "linear-bot"
  | "slack-bot";
export type ConfidenceLevel = "high" | "medium" | "low";

export const sandboxStatusSchema = z.enum([
  "pending",
  "spawning",
  "connecting",
  "warming",
  "syncing",
  "ready",
  "running",
  "stale",
  "snapshotting",
  "stopped",
  "failed",
]);
export const gitSyncStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"]);
export const artifactTypeSchema = z.enum(["pr", "screenshot", "video", "preview", "branch"]);
export const eventTypeSchema = z.enum([
  "heartbeat",
  "ready",
  "token",
  "tool_call",
  "step_start",
  "step_finish",
  "tool_result",
  "git_sync",
  "error",
  "execution_complete",
  "artifact",
  "push_complete",
  "push_error",
  "warning",
  "session_title",
  "user_message",
]);
export const spawnSourceSchema = z.enum([
  "user",
  "agent",
  "automation",
  "github-bot",
  "linear-bot",
  "slack-bot",
]);
