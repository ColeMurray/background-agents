/**
 * Tests for ParticipantRepository implementation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { FakeSqlStorage } from "../../test/fakes/fake-sql-storage";
import { createParticipantRepository } from "./participant-repository";
import { initSchema } from "../schema";
import type { ParticipantRepository } from "./types";

describe("ParticipantRepository", () => {
  let sql: FakeSqlStorage;
  let repo: ParticipantRepository;

  beforeEach(() => {
    sql = new FakeSqlStorage();
    initSchema(sql as unknown as SqlStorage);
    repo = createParticipantRepository(sql as unknown as SqlStorage);
  });

  describe("create", () => {
    it("should create a new participant with required fields", () => {
      const now = Date.now();
      const participant = repo.create({
        id: "participant-1",
        userId: "user-1",
        role: "owner",
        joinedAt: now,
      });

      expect(participant.id).toBe("participant-1");
      expect(participant.user_id).toBe("user-1");
      expect(participant.role).toBe("owner");
      expect(participant.joined_at).toBe(now);
    });

    it("should create a participant with GitHub info", () => {
      const participant = repo.create({
        id: "participant-1",
        userId: "user-1",
        githubUserId: "123456",
        githubLogin: "octocat",
        githubEmail: "octocat@github.com",
        githubName: "The Octocat",
        role: "member",
        joinedAt: Date.now(),
      });

      expect(participant.github_user_id).toBe("123456");
      expect(participant.github_login).toBe("octocat");
      expect(participant.github_email).toBe("octocat@github.com");
      expect(participant.github_name).toBe("The Octocat");
    });

    it("should create a participant with encrypted tokens", () => {
      const participant = repo.create({
        id: "participant-1",
        userId: "user-1",
        role: "owner",
        githubAccessTokenEncrypted: "encrypted-access-token",
        githubRefreshTokenEncrypted: "encrypted-refresh-token",
        githubTokenExpiresAt: Date.now() + 3600000,
        joinedAt: Date.now(),
      });

      expect(participant.github_access_token_encrypted).toBe("encrypted-access-token");
      expect(participant.github_refresh_token_encrypted).toBe("encrypted-refresh-token");
      expect(participant.github_token_expires_at).toBeGreaterThan(Date.now());
    });

    it("should create a participant with WebSocket auth token", () => {
      const now = Date.now();
      const participant = repo.create({
        id: "participant-1",
        userId: "user-1",
        role: "member",
        wsAuthToken: "hashed-token",
        wsTokenCreatedAt: now,
        joinedAt: now,
      });

      expect(participant.ws_auth_token).toBe("hashed-token");
      expect(participant.ws_token_created_at).toBe(now);
    });
  });

  describe("getById", () => {
    it("should return null when participant does not exist", () => {
      const participant = repo.getById("nonexistent");
      expect(participant).toBeNull();
    });

    it("should return participant when it exists", () => {
      repo.create({
        id: "participant-1",
        userId: "user-1",
        role: "owner",
        joinedAt: Date.now(),
      });

      const participant = repo.getById("participant-1");
      expect(participant).not.toBeNull();
      expect(participant?.id).toBe("participant-1");
    });
  });

  describe("getByUserId", () => {
    it("should return null when user has no participant", () => {
      const participant = repo.getByUserId("user-999");
      expect(participant).toBeNull();
    });

    it("should return participant for user", () => {
      repo.create({
        id: "participant-1",
        userId: "user-1",
        role: "owner",
        joinedAt: Date.now(),
      });

      const participant = repo.getByUserId("user-1");
      expect(participant).not.toBeNull();
      expect(participant?.user_id).toBe("user-1");
    });
  });

  describe("getByWsAuthToken", () => {
    it("should return null when token does not match", () => {
      const participant = repo.getByWsAuthToken("wrong-token");
      expect(participant).toBeNull();
    });

    it("should return participant with matching token", () => {
      repo.create({
        id: "participant-1",
        userId: "user-1",
        role: "owner",
        wsAuthToken: "hashed-token-123",
        wsTokenCreatedAt: Date.now(),
        joinedAt: Date.now(),
      });

      const participant = repo.getByWsAuthToken("hashed-token-123");
      expect(participant).not.toBeNull();
      expect(participant?.id).toBe("participant-1");
    });
  });

  describe("updateTokens", () => {
    beforeEach(() => {
      repo.create({
        id: "participant-1",
        userId: "user-1",
        role: "owner",
        joinedAt: Date.now(),
      });
    });

    it("should update access token", () => {
      repo.updateTokens("participant-1", {
        githubAccessTokenEncrypted: "new-access-token",
      });

      const participant = repo.getById("participant-1");
      expect(participant?.github_access_token_encrypted).toBe("new-access-token");
    });

    it("should update refresh token", () => {
      repo.updateTokens("participant-1", {
        githubRefreshTokenEncrypted: "new-refresh-token",
      });

      const participant = repo.getById("participant-1");
      expect(participant?.github_refresh_token_encrypted).toBe("new-refresh-token");
    });

    it("should update token expiry", () => {
      const expiresAt = Date.now() + 7200000;
      repo.updateTokens("participant-1", {
        githubTokenExpiresAt: expiresAt,
      });

      const participant = repo.getById("participant-1");
      expect(participant?.github_token_expires_at).toBe(expiresAt);
    });

    it("should update all token fields", () => {
      const expiresAt = Date.now() + 3600000;
      repo.updateTokens("participant-1", {
        githubAccessTokenEncrypted: "new-access",
        githubRefreshTokenEncrypted: "new-refresh",
        githubTokenExpiresAt: expiresAt,
      });

      const participant = repo.getById("participant-1");
      expect(participant?.github_access_token_encrypted).toBe("new-access");
      expect(participant?.github_refresh_token_encrypted).toBe("new-refresh");
      expect(participant?.github_token_expires_at).toBe(expiresAt);
    });
  });

  describe("updateWsAuthToken", () => {
    beforeEach(() => {
      repo.create({
        id: "participant-1",
        userId: "user-1",
        role: "owner",
        joinedAt: Date.now(),
      });
    });

    it("should set WebSocket auth token", () => {
      const now = Date.now();
      repo.updateWsAuthToken("participant-1", "hashed-token", now);

      const participant = repo.getById("participant-1");
      expect(participant?.ws_auth_token).toBe("hashed-token");
      expect(participant?.ws_token_created_at).toBe(now);
    });

    it("should clear WebSocket auth token", () => {
      repo.updateWsAuthToken("participant-1", "hashed-token", Date.now());
      repo.updateWsAuthToken("participant-1", null, null);

      const participant = repo.getById("participant-1");
      expect(participant?.ws_auth_token).toBeNull();
      expect(participant?.ws_token_created_at).toBeNull();
    });
  });

  describe("list", () => {
    it("should return empty array when no participants exist", () => {
      const participants = repo.list();
      expect(participants).toEqual([]);
    });

    it("should return all participants", () => {
      const now = Date.now();
      repo.create({
        id: "participant-1",
        userId: "user-1",
        role: "owner",
        joinedAt: now - 1000,
      });
      repo.create({
        id: "participant-2",
        userId: "user-2",
        role: "member",
        joinedAt: now,
      });

      const participants = repo.list();
      expect(participants).toHaveLength(2);
    });

    it("should return participants ordered by joined_at", () => {
      const now = Date.now();
      repo.create({
        id: "participant-2",
        userId: "user-2",
        role: "member",
        joinedAt: now,
      });
      repo.create({
        id: "participant-1",
        userId: "user-1",
        role: "owner",
        joinedAt: now - 1000,
      });

      const participants = repo.list();
      expect(participants[0].id).toBe("participant-1");
      expect(participants[1].id).toBe("participant-2");
    });
  });
});
