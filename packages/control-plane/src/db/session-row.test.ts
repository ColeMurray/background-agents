import { describe, expect, it } from "vitest";
import { encodeSessionStatus, parseSessionRow, toSessionFields } from "./session-row";

const row = {
  id: "session-1",
  title: null,
  repo_owner: null,
  repo_name: null,
  harness: "pi",
  model: "openai/gpt-5.6-sol",
  reasoning_effort: null,
  base_branch: null,
  status: "durable_active",
  parent_session_id: null,
  root_session_id: null,
  spawn_source: "user",
  spawn_depth: 0,
  automation_id: null,
  automation_run_id: null,
  scm_login: null,
  user_id: "user-1",
  owner_team_id: null,
  visibility: "workspace",
  project_id: null,
  total_cost: 0,
  active_duration_ms: 0,
  message_count: 0,
  pr_count: 0,
  input_tokens: 0,
  output_tokens: 0,
  reasoning_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  environment_id: null,
  created_at: 1,
  updated_at: 1,
};

describe("persisted in-process session status", () => {
  it("marks promptable in-process rows so an older binary fails closed", () => {
    expect(encodeSessionStatus("pi", "created")).toBe("durable_created");
    expect(encodeSessionStatus("pi", "active")).toBe("durable_active");
    expect(encodeSessionStatus("opencode", "active")).toBe("active");
  });

  it("normalizes the marker only after the current binary recognizes the harness", () => {
    const parsed = parseSessionRow(row);
    expect(parsed && toSessionFields(parsed).status).toBe("active");
    expect(() => parseSessionRow({ ...row, harness: "future-harness" })).toThrow(
      "Malformed persisted session index row"
    );
  });
});
