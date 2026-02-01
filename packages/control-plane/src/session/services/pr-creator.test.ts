/**
 * Tests for PRCreator service.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { createPRCreator } from "./pr-creator";
import type { PRCreator } from "./types";
import type { ParticipantRepository, ArtifactRepository } from "../repository/types";
import { createParticipantRepository, createArtifactRepository } from "../repository";
import { FakeSqlStorage } from "../../test/fakes/fake-sql-storage";

describe("PRCreator", () => {
  let creator: PRCreator;
  let participantRepo: ParticipantRepository;
  let artifactRepo: ArtifactRepository;
  let mockSendToSandbox: Mock;
  let mockCreateGitHubPR: Mock;
  let sql: FakeSqlStorage;

  beforeEach(() => {
    sql = new FakeSqlStorage();

    // Create participants table
    sql.exec(`
      CREATE TABLE participants (
        id TEXT PRIMARY KEY,
        user_id TEXT UNIQUE NOT NULL,
        github_user_id TEXT,
        github_login TEXT,
        github_email TEXT,
        github_name TEXT,
        role TEXT NOT NULL,
        github_access_token_encrypted TEXT,
        github_refresh_token_encrypted TEXT,
        github_token_expires_at INTEGER,
        ws_auth_token TEXT,
        ws_token_created_at INTEGER,
        joined_at INTEGER NOT NULL
      )
    `);

    // Create artifacts table
    sql.exec(`
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        url TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    // Add test participant with GitHub token
    sql.exec(
      `INSERT INTO participants (
        id, user_id, github_login, github_access_token_encrypted, role, joined_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      "participant-1",
      "user-1",
      "testuser",
      "encrypted_token",
      "member",
      Date.now()
    );

    participantRepo = createParticipantRepository(sql);
    artifactRepo = createArtifactRepository(sql);
    mockSendToSandbox = vi.fn().mockResolvedValue(undefined);
    mockCreateGitHubPR = vi.fn().mockResolvedValue({
      number: 123,
      html_url: "https://github.com/owner/repo/pull/123",
    });

    creator = createPRCreator({
      participantRepo,
      artifactRepo,
      sendToSandbox: mockSendToSandbox,
      createGitHubPR: mockCreateGitHubPR,
    });
  });

  describe("createPullRequest", () => {
    it("should find participant with valid GitHub token", async () => {
      const prData = {
        branch: "feature-branch",
        title: "Test PR",
        body: "PR description",
      };

      await creator.createPullRequest(prData);

      const participant = participantRepo.getById("participant-1");
      expect(participant).toBeDefined();
      expect(participant?.github_access_token_encrypted).toBe("encrypted_token");
    });

    it("should send push command to sandbox", async () => {
      const prData = {
        branch: "feature-branch",
        title: "Test PR",
        body: "PR description",
      };

      await creator.createPullRequest(prData);

      expect(mockSendToSandbox).toHaveBeenCalledWith({
        type: "push_branch",
        branch: "feature-branch",
      });
    });

    it("should create GitHub PR after push", async () => {
      const prData = {
        branch: "feature-branch",
        title: "Test PR",
        body: "PR description",
      };

      await creator.createPullRequest(prData);

      expect(mockCreateGitHubPR).toHaveBeenCalledWith({
        branch: "feature-branch",
        title: "Test PR",
        body: "PR description",
        token: "encrypted_token",
      });
    });

    it("should store PR artifact", async () => {
      const prData = {
        branch: "feature-branch",
        title: "Test PR",
        body: "PR description",
      };

      await creator.createPullRequest(prData);

      const artifacts = artifactRepo.list();
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].type).toBe("pull_request");
      expect(artifacts[0].url).toBe("https://github.com/owner/repo/pull/123");
    });

    it("should include PR metadata in artifact", async () => {
      const prData = {
        branch: "feature-branch",
        title: "Test PR",
        body: "PR description",
      };

      await creator.createPullRequest(prData);

      const artifacts = artifactRepo.list();
      const metadata = JSON.parse(artifacts[0].metadata!);

      expect(metadata).toEqual({
        number: 123,
        branch: "feature-branch",
        title: "Test PR",
      });
    });

    it("should throw if no participant has GitHub token", async () => {
      // Delete participant with token and add one without
      sql.exec(`DELETE FROM participants WHERE id = ?`, "participant-1");
      sql.exec(
        `INSERT INTO participants (
          id, user_id, github_login, role, joined_at
        ) VALUES (?, ?, ?, ?, ?)`,
        "participant-2",
        "user-2",
        "testuser2",
        "member",
        Date.now()
      );

      // Recreate services with updated data
      creator = createPRCreator({
        participantRepo,
        artifactRepo,
        sendToSandbox: mockSendToSandbox,
        createGitHubPR: mockCreateGitHubPR,
      });

      const prData = {
        branch: "feature-branch",
        title: "Test PR",
        body: "PR description",
      };

      await expect(creator.createPullRequest(prData)).rejects.toThrow(
        "No participant with valid GitHub token found"
      );
    });

    it("should handle push errors gracefully", async () => {
      mockSendToSandbox.mockRejectedValueOnce(new Error("Push failed"));

      const prData = {
        branch: "feature-branch",
        title: "Test PR",
        body: "PR description",
      };

      await expect(creator.createPullRequest(prData)).rejects.toThrow("Push failed");
    });

    it("should handle GitHub API errors gracefully", async () => {
      mockCreateGitHubPR.mockRejectedValueOnce(new Error("API failed"));

      const prData = {
        branch: "feature-branch",
        title: "Test PR",
        body: "PR description",
      };

      await expect(creator.createPullRequest(prData)).rejects.toThrow("API failed");
    });
  });

  describe("findParticipantWithToken", () => {
    it("should return participant with token", () => {
      const participant = creator.findParticipantWithToken();

      expect(participant).toBeDefined();
      expect(participant?.id).toBe("participant-1");
      expect(participant?.github_access_token_encrypted).toBe("encrypted_token");
    });

    it("should return null if no participant has token", () => {
      // Delete participant with token and add one without
      sql.exec(`DELETE FROM participants WHERE id = ?`, "participant-1");
      sql.exec(
        `INSERT INTO participants (
          id, user_id, github_login, role, joined_at
        ) VALUES (?, ?, ?, ?, ?)`,
        "participant-3",
        "user-3",
        "testuser3",
        "member",
        Date.now()
      );

      // Recreate service with updated data
      creator = createPRCreator({
        participantRepo,
        artifactRepo,
        sendToSandbox: mockSendToSandbox,
        createGitHubPR: mockCreateGitHubPR,
      });

      const participant = creator.findParticipantWithToken();

      expect(participant).toBeNull();
    });

    it("should return first participant with token if multiple exist", () => {
      // Add another participant with token
      sql.exec(
        `INSERT INTO participants (
          id, user_id, github_login, github_access_token_encrypted, role, joined_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        "participant-2",
        "user-2",
        "testuser2",
        "encrypted_token_2",
        "member",
        Date.now()
      );

      const participant = creator.findParticipantWithToken();

      expect(participant).toBeDefined();
      // Should return one of the participants with token
      expect(participant?.github_access_token_encrypted).toBeTruthy();
    });
  });
});
