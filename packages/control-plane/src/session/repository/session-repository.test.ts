/**
 * Tests for SessionRepository implementation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { FakeSqlStorage } from "../../test/fakes/fake-sql-storage";
import { createSessionRepository } from "./session-repository";
import { initSchema } from "../schema";
import type { SessionRepository } from "./types";

describe("SessionRepository", () => {
  let sql: FakeSqlStorage;
  let repo: SessionRepository;

  beforeEach(() => {
    sql = new FakeSqlStorage();
    initSchema(sql as unknown as SqlStorage);
    repo = createSessionRepository(sql as unknown as SqlStorage);
  });

  describe("create", () => {
    it("should create a new session", () => {
      const now = Date.now();
      const session = repo.create({
        id: "session-1",
        session_name: null,
        title: "Fix login bug",
        repo_owner: "acme",
        repo_name: "webapp",
        repo_default_branch: "main",
        branch_name: null,
        base_sha: null,
        current_sha: null,
        opencode_session_id: null,
        model: "claude-haiku-4-5",
        status: "created",
        linear_issue_id: null,
        linear_team_id: null,
      });

      expect(session.id).toBe("session-1");
      expect(session.title).toBe("Fix login bug");
      expect(session.repo_owner).toBe("acme");
      expect(session.repo_name).toBe("webapp");
      expect(session.status).toBe("created");
      expect(session.created_at).toBeGreaterThanOrEqual(now);
      expect(session.updated_at).toBeGreaterThanOrEqual(now);
    });

    it("should set default model if not provided", () => {
      const session = repo.create({
        id: "session-1",
        session_name: null,
        title: null,
        repo_owner: "acme",
        repo_name: "webapp",
        repo_default_branch: "main",
        branch_name: null,
        base_sha: null,
        current_sha: null,
        opencode_session_id: null,
        model: "claude-sonnet-4-5",
        status: "created",
        linear_issue_id: null,
        linear_team_id: null,
      });

      expect(session.model).toBe("claude-sonnet-4-5");
    });
  });

  describe("get", () => {
    it("should return null when session does not exist", () => {
      const session = repo.get();
      expect(session).toBeNull();
    });

    it("should return session when it exists", () => {
      repo.create({
        id: "session-1",
        session_name: null,
        title: "Test",
        repo_owner: "acme",
        repo_name: "webapp",
        repo_default_branch: "main",
        branch_name: null,
        base_sha: null,
        current_sha: null,
        opencode_session_id: null,
        model: "claude-haiku-4-5",
        status: "created",
        linear_issue_id: null,
        linear_team_id: null,
      });

      const session = repo.get();
      expect(session).not.toBeNull();
      expect(session?.id).toBe("session-1");
    });
  });

  describe("update", () => {
    beforeEach(() => {
      repo.create({
        id: "session-1",
        session_name: null,
        title: "Original title",
        repo_owner: "acme",
        repo_name: "webapp",
        repo_default_branch: "main",
        branch_name: null,
        base_sha: null,
        current_sha: null,
        opencode_session_id: null,
        model: "claude-haiku-4-5",
        status: "created",
        linear_issue_id: null,
        linear_team_id: null,
      });
    });

    it("should update title", () => {
      repo.update({ title: "Updated title" });

      const session = repo.get();
      expect(session?.title).toBe("Updated title");
    });

    it("should update branch name", () => {
      repo.update({ branchName: "feature/new-auth" });

      const session = repo.get();
      expect(session?.branch_name).toBe("feature/new-auth");
    });

    it("should update base SHA", () => {
      repo.update({ baseSha: "abc123" });

      const session = repo.get();
      expect(session?.base_sha).toBe("abc123");
    });

    it("should update current SHA", () => {
      repo.update({ currentSha: "def456" });

      const session = repo.get();
      expect(session?.current_sha).toBe("def456");
    });

    it("should update opencode session ID", () => {
      repo.update({ opencodeSessionId: "opencode-123" });

      const session = repo.get();
      expect(session?.opencode_session_id).toBe("opencode-123");
    });

    it("should update status", () => {
      repo.update({ status: "active" });

      const session = repo.get();
      expect(session?.status).toBe("active");
    });

    it("should update multiple fields at once", () => {
      repo.update({
        title: "New title",
        branchName: "feat/auth",
        status: "active",
      });

      const session = repo.get();
      expect(session?.title).toBe("New title");
      expect(session?.branch_name).toBe("feat/auth");
      expect(session?.status).toBe("active");
    });

    it("should update updated_at timestamp", () => {
      const before = Date.now();
      repo.update({ title: "New" });

      const session = repo.get();
      expect(session?.updated_at).toBeGreaterThanOrEqual(before);
    });
  });

  describe("updateStatus", () => {
    beforeEach(() => {
      repo.create({
        id: "session-1",
        session_name: null,
        title: "Test",
        repo_owner: "acme",
        repo_name: "webapp",
        repo_default_branch: "main",
        branch_name: null,
        base_sha: null,
        current_sha: null,
        opencode_session_id: null,
        model: "claude-haiku-4-5",
        status: "created",
        linear_issue_id: null,
        linear_team_id: null,
      });
    });

    it("should update status to active", () => {
      repo.updateStatus("active");

      const session = repo.get();
      expect(session?.status).toBe("active");
    });

    it("should update status to completed", () => {
      repo.updateStatus("completed");

      const session = repo.get();
      expect(session?.status).toBe("completed");
    });
  });

  describe("updateCurrentSha", () => {
    beforeEach(() => {
      repo.create({
        id: "session-1",
        session_name: null,
        title: "Test",
        repo_owner: "acme",
        repo_name: "webapp",
        repo_default_branch: "main",
        branch_name: null,
        base_sha: null,
        current_sha: null,
        opencode_session_id: null,
        model: "claude-haiku-4-5",
        status: "created",
        linear_issue_id: null,
        linear_team_id: null,
      });
    });

    it("should update current SHA", () => {
      repo.updateCurrentSha("abc123def456");

      const session = repo.get();
      expect(session?.current_sha).toBe("abc123def456");
    });
  });
});
