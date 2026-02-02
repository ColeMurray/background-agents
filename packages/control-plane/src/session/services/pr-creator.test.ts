/**
 * Tests for PRCreator service.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { createPRCreator } from "./pr-creator";
import type { PRCreator } from "./types";
import type {
  MessageRepository,
  ParticipantRepository,
  ArtifactRepository,
} from "../repository/types";
import {
  createMessageRepository,
  createParticipantRepository,
  createArtifactRepository,
} from "../repository";
import { FakeSqlStorage } from "../../test/fakes/fake-sql-storage";

import type { GitHubPort } from "../../ports/github-port";

describe("PRCreator", () => {
  let creator: PRCreator;
  let messageRepo: MessageRepository;
  let participantRepo: ParticipantRepository;
  let artifactRepo: ArtifactRepository;
  let mockGetSandboxWebSocket: Mock;
  let mockSafeSend: Mock;
  let mockRegisterPushPromise: Mock;
  let mockBroadcast: Mock;
  let mockGitHub: GitHubPort;
  let sql: FakeSqlStorage;

  beforeEach(() => {
    sql = new FakeSqlStorage();

    // ... (tables creation code stays same) ...
    // Create messages table
    sql.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        author_id TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        model TEXT,
        attachments TEXT,
        callback_context TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER
      )
    `);

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
        id, user_id, github_login, github_access_token_encrypted, github_token_expires_at, role, joined_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      "participant-1",
      "user-1",
      "testuser",
      "encrypted_token",
      Date.now() + 3600000, // Expires in 1 hour
      "member",
      Date.now()
    );

    messageRepo = createMessageRepository(sql);
    participantRepo = createParticipantRepository(sql);
    artifactRepo = createArtifactRepository(sql);

    mockGetSandboxWebSocket = vi.fn().mockReturnValue({ id: "ws-1" });
    mockSafeSend = vi.fn().mockReturnValue(true);
    mockRegisterPushPromise = vi.fn().mockImplementation((_, resolve) => {
      // Immediately resolve for testing
      setTimeout(resolve, 0);
      return { timeoutId: setTimeout(() => {}, 180000) };
    });
    mockBroadcast = vi.fn();

    mockGitHub = {
      createPullRequest: vi.fn().mockResolvedValue({
        number: 123,
        htmlUrl: "https://github.com/owner/repo/pull/123",
        state: "open",
        url: "https://api.github.com/repos/owner/repo/pulls/123",
      }),
      exchangeCodeForToken: vi.fn(),
      refreshAccessToken: vi.fn(),
      getCurrentUser: vi.fn(),
      generateInstallationToken: vi.fn(),
      getPullRequestByHead: vi.fn(),
      getRepository: vi.fn(),
      listInstallationRepositories: vi.fn(),
    };

    creator = createPRCreator({
      messageRepo,
      participantRepo,
      artifactRepo,
      getSandboxWebSocket: mockGetSandboxWebSocket,
      safeSend: mockSafeSend,
      registerPushPromise: mockRegisterPushPromise,
      broadcast: mockBroadcast,
      github: mockGitHub,
    });
  });

  describe("getPromptingUser", () => {
    it("should return user from processing message", async () => {
      // Add a processing message
      messageRepo.create({
        id: "msg-1",
        authorId: "participant-1",
        content: "test",
        source: "web",
        status: "pending",
        createdAt: Date.now(),
      });
      messageRepo.updateStatus("msg-1", "processing", { startedAt: Date.now() });

      const result = await creator.getPromptingUser();

      expect(result.user).toBeDefined();
      expect(result.user!.id).toBe("participant-1");
      expect(result.user!.github_access_token_encrypted).toBe("encrypted_token");
    });

    it("should return error if no processing message", async () => {
      const result = await creator.getPromptingUser();

      expect(result.user).toBeUndefined();
      expect(result.error).toContain("No active prompt found");
      expect(result.status).toBe(400);
    });

    it("should return error if participant not found", async () => {
      // Add processing message with nonexistent participant
      messageRepo.create({
        id: "msg-1",
        authorId: "nonexistent",
        content: "test",
        source: "web",
        status: "pending",
        createdAt: Date.now(),
      });
      messageRepo.updateStatus("msg-1", "processing", { startedAt: Date.now() });

      const result = await creator.getPromptingUser();

      expect(result.user).toBeUndefined();
      expect(result.error).toContain("User not found");
      expect(result.status).toBe(401);
    });

    it("should return error if participant has no GitHub token", async () => {
      // Add participant without token
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

      // Add processing message from this participant
      messageRepo.create({
        id: "msg-2",
        authorId: "participant-2",
        content: "test",
        source: "web",
        status: "pending",
        createdAt: Date.now(),
      });
      messageRepo.updateStatus("msg-2", "processing", { startedAt: Date.now() });

      const result = await creator.getPromptingUser();

      expect(result.user).toBeUndefined();
      expect(result.error).toContain("GitHub token is not available");
      expect(result.status).toBe(401);
    });

    it("should return error if GitHub token is expired", async () => {
      // Add participant with expired token
      sql.exec(
        `INSERT INTO participants (
          id, user_id, github_login, github_access_token_encrypted, github_token_expires_at, role, joined_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        "participant-3",
        "user-3",
        "testuser3",
        "expired_token",
        Date.now() - 3600000, // Expired 1 hour ago
        "member",
        Date.now()
      );

      // Add processing message from this participant
      messageRepo.create({
        id: "msg-3",
        authorId: "participant-3",
        content: "test",
        source: "web",
        status: "pending",
        createdAt: Date.now(),
      });
      messageRepo.updateStatus("msg-3", "processing", { startedAt: Date.now() });

      const result = await creator.getPromptingUser();

      expect(result.user).toBeUndefined();
      expect(result.error).toContain("token has expired");
      expect(result.status).toBe(401);
    });
  });

  describe("isTokenExpired", () => {
    it("should return false for valid token", () => {
      const participant = participantRepo.getById("participant-1")!;
      const isExpired = creator.isTokenExpired(participant);

      expect(isExpired).toBe(false);
    });

    it("should return true for expired token", () => {
      // Add participant with expired token
      sql.exec(
        `INSERT INTO participants (
          id, user_id, github_login, github_access_token_encrypted, github_token_expires_at, role, joined_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        "participant-expired",
        "user-expired",
        "expireduser",
        "expired_token",
        Date.now() - 1000, // Expired 1 second ago
        "member",
        Date.now()
      );

      const participant = participantRepo.getById("participant-expired")!;
      const isExpired = creator.isTokenExpired(participant);

      expect(isExpired).toBe(true);
    });

    it("should return false if no expiration set", () => {
      // Add participant without expiration
      sql.exec(
        `INSERT INTO participants (
          id, user_id, github_login, github_access_token_encrypted, role, joined_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        "participant-no-expiry",
        "user-no-expiry",
        "noexpiryuser",
        "token",
        "member",
        Date.now()
      );

      const participant = participantRepo.getById("participant-no-expiry")!;
      const isExpired = creator.isTokenExpired(participant);

      expect(isExpired).toBe(false);
    });

    it("should respect buffer time", () => {
      // Add participant with token expiring soon
      const expiresAt = Date.now() + 30000; // 30 seconds from now
      sql.exec(
        `INSERT INTO participants (
          id, user_id, github_login, github_access_token_encrypted, github_token_expires_at, role, joined_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        "participant-soon",
        "user-soon",
        "soonuser",
        "token",
        expiresAt,
        "member",
        Date.now()
      );

      const participant = participantRepo.getById("participant-soon")!;

      // With default buffer (60 seconds), should be considered expired
      expect(creator.isTokenExpired(participant)).toBe(true);

      // With smaller buffer (10 seconds), should not be expired
      expect(creator.isTokenExpired(participant, 10000)).toBe(false);
    });
  });

  describe("pushBranch", () => {
    it("should send push command to sandbox", async () => {
      const result = await creator.pushBranch({
        branchName: "feature-branch",
        repoOwner: "owner",
        repoName: "repo",
        githubToken: "token",
      });

      expect(result.success).toBe(true);
      expect(mockSafeSend).toHaveBeenCalledWith(
        { id: "ws-1" },
        expect.objectContaining({
          type: "push",
          branchName: "feature-branch",
          repoOwner: "owner",
          repoName: "repo",
          githubToken: "token",
        })
      );
      expect(mockRegisterPushPromise).toHaveBeenCalledWith(
        "feature-branch",
        expect.any(Function),
        expect.any(Function)
      );
    });

    it("should return success if no sandbox connected", async () => {
      mockGetSandboxWebSocket.mockReturnValue(null);

      const result = await creator.pushBranch({
        branchName: "feature-branch",
        repoOwner: "owner",
        repoName: "repo",
      });

      expect(result.success).toBe(true);
      expect(mockSafeSend).not.toHaveBeenCalled();
    });

    it("should handle push timeout", async () => {
      mockRegisterPushPromise.mockImplementation((_, __, reject) => {
        setTimeout(() => reject(new Error("Push operation timed out after 180 seconds")), 10);
        return { timeoutId: setTimeout(() => {}, 180000) };
      });

      const result = await creator.pushBranch({
        branchName: "feature-branch",
        repoOwner: "owner",
        repoName: "repo",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("timed out");
    });
  });

  describe("createPR", () => {
    it("should create PR and store artifact", async () => {
      const result = await creator.createPR({
        title: "Test PR",
        body: "PR body",
        baseBranch: "main",
        headBranch: "feature-branch",
        repoOwner: "owner",
        repoName: "repo",
        userToken: "encrypted_token",
      });

      expect(mockGitHub.createPullRequest).toHaveBeenCalledWith({
        accessTokenEncrypted: "encrypted_token",
        owner: "owner",
        repo: "repo",
        title: "Test PR",
        body: "PR body",
        head: "feature-branch",
        base: "main",
      });

      expect(result.prNumber).toBe(123);
      expect(result.prUrl).toBe("https://github.com/owner/repo/pull/123");
      expect(result.state).toBe("open");

      // Check artifact was created
      const artifacts = artifactRepo.list();
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].type).toBe("pr");
      expect(artifacts[0].url).toBe("https://github.com/owner/repo/pull/123");

      // Check broadcast was called
      expect(mockBroadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "artifact_created",
          artifact: expect.objectContaining({
            type: "pr",
            prNumber: 123,
          }),
        })
      );
    });
  });
});
