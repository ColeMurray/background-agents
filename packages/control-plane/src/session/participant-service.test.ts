import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Logger } from "../logger";
import type { ParticipantRow } from "./types";
import {
  ParticipantService,
  getGitHubAvatarUrl,
  type ParticipantRepository,
  type ParticipantServiceDeps,
  type ParticipantServiceEnv,
} from "./participant-service";

// ---- Mock factories ----

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createMockLogger()),
  };
}

function createParticipant(overrides: Partial<ParticipantRow> = {}): ParticipantRow {
  return {
    id: "part-1",
    user_id: "user-1",
    scm_provider: "github",
    scm_user_id: null,
    scm_login: null,
    scm_email: null,
    scm_name: "Test User",
    scm_access_token_encrypted: null,
    scm_refresh_token_encrypted: null,
    scm_token_expires_at: null,
    github_user_id: null,
    github_login: null,
    github_email: null,
    github_name: "Test User",
    role: "member",
    github_access_token_encrypted: null,
    github_refresh_token_encrypted: null,
    github_token_expires_at: null,
    ws_auth_token: null,
    ws_token_created_at: null,
    joined_at: 1000,
    ...overrides,
  };
}

function createMockRepository(): ParticipantRepository {
  return {
    getParticipantByUserId: vi.fn(() => null),
    getParticipantByWsTokenHash: vi.fn(() => null),
    getParticipantById: vi.fn(() => null),
    getProcessingMessageAuthor: vi.fn(() => null),
    createParticipant: vi.fn(),
    updateParticipantTokens: vi.fn(),
    updateParticipantScmTokens: vi.fn(),
  };
}

function createTestHarness(overrides?: { env?: Partial<ParticipantServiceEnv> }) {
  const log = createMockLogger();
  const repository = createMockRepository();
  let idCounter = 0;

  const env: ParticipantServiceEnv = {
    GITHUB_CLIENT_ID: "client-id",
    GITHUB_CLIENT_SECRET: "client-secret",
    TOKEN_ENCRYPTION_KEY: "test-encryption-key-32-chars-long",
    ...overrides?.env,
  };

  const deps: ParticipantServiceDeps = {
    repository,
    env,
    log,
    generateId: () => `gen-id-${++idCounter}`,
  };

  return {
    service: new ParticipantService(deps),
    repository,
    log,
    env,
  };
}

// ---- Tests ----

describe("getGitHubAvatarUrl", () => {
  it("returns avatar URL for a login", () => {
    expect(getGitHubAvatarUrl("octocat")).toBe("https://github.com/octocat.png");
  });

  it("returns undefined for null", () => {
    expect(getGitHubAvatarUrl(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(getGitHubAvatarUrl(undefined)).toBeUndefined();
  });
});

describe("ParticipantService", () => {
  let harness: ReturnType<typeof createTestHarness>;

  beforeEach(() => {
    harness = createTestHarness();
  });

  describe("getByUserId", () => {
    it("delegates to repository", () => {
      const participant = createParticipant();
      vi.mocked(harness.repository.getParticipantByUserId).mockReturnValue(participant);

      const result = harness.service.getByUserId("user-1");

      expect(result).toBe(participant);
      expect(harness.repository.getParticipantByUserId).toHaveBeenCalledWith("user-1");
    });

    it("returns null when not found", () => {
      const result = harness.service.getByUserId("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("getByWsTokenHash", () => {
    it("delegates to repository", () => {
      const participant = createParticipant();
      vi.mocked(harness.repository.getParticipantByWsTokenHash).mockReturnValue(participant);

      const result = harness.service.getByWsTokenHash("hash-123");

      expect(result).toBe(participant);
      expect(harness.repository.getParticipantByWsTokenHash).toHaveBeenCalledWith("hash-123");
    });
  });

  describe("create", () => {
    it("creates participant with member role and returns constructed row", () => {
      const result = harness.service.create("user-42", "Alice");

      expect(harness.repository.createParticipant).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "gen-id-1",
          userId: "user-42",
          githubName: "Alice",
          role: "member",
        })
      );
      expect(result.id).toBe("gen-id-1");
      expect(result.user_id).toBe("user-42");
      expect(result.github_name).toBe("Alice");
      expect(result.role).toBe("member");
      expect(result.github_access_token_encrypted).toBeNull();
    });
  });

  describe("getPromptingParticipantForPR", () => {
    it("returns participant when processing message exists", async () => {
      const participant = createParticipant({ id: "part-99" });
      vi.mocked(harness.repository.getProcessingMessageAuthor).mockReturnValue({
        author_id: "part-99",
      });
      vi.mocked(harness.repository.getParticipantById).mockReturnValue(participant);

      const result = await harness.service.getPromptingParticipantForPR();

      expect(result).toEqual({ participant });
    });

    it("returns error 400 when no processing message", async () => {
      vi.mocked(harness.repository.getProcessingMessageAuthor).mockReturnValue(null);

      const result = await harness.service.getPromptingParticipantForPR();

      expect(result).toEqual(expect.objectContaining({ error: expect.any(String), status: 400 }));
    });

    it("returns error 401 when participant not found", async () => {
      vi.mocked(harness.repository.getProcessingMessageAuthor).mockReturnValue({
        author_id: "ghost",
      });
      vi.mocked(harness.repository.getParticipantById).mockReturnValue(null);

      const result = await harness.service.getPromptingParticipantForPR();

      expect(result).toEqual(expect.objectContaining({ error: expect.any(String), status: 401 }));
    });
  });

  describe("isGitHubTokenExpired", () => {
    it("returns false when no expiry is set", () => {
      const participant = createParticipant({ github_token_expires_at: null });
      expect(harness.service.isGitHubTokenExpired(participant)).toBe(false);
    });

    it("returns false when token is still valid", () => {
      const participant = createParticipant({
        github_token_expires_at: Date.now() + 120000, // 2 minutes from now
      });
      expect(harness.service.isGitHubTokenExpired(participant)).toBe(false);
    });

    it("returns true when token is within default buffer", () => {
      const participant = createParticipant({
        github_token_expires_at: Date.now() + 30000, // 30 seconds from now, within 60s buffer
      });
      expect(harness.service.isGitHubTokenExpired(participant)).toBe(true);
    });

    it("returns true when token is already expired", () => {
      const participant = createParticipant({
        github_token_expires_at: Date.now() - 1000,
      });
      expect(harness.service.isGitHubTokenExpired(participant)).toBe(true);
    });

    it("respects custom buffer", () => {
      const participant = createParticipant({
        github_token_expires_at: Date.now() + 30000,
      });
      // With 10s buffer, 30s remaining should NOT be expired
      expect(harness.service.isGitHubTokenExpired(participant, 10000)).toBe(false);
      // With 60s buffer, 30s remaining SHOULD be expired
      expect(harness.service.isGitHubTokenExpired(participant, 60000)).toBe(true);
    });
  });

  describe("refreshToken", () => {
    it("returns null when no refresh token stored", async () => {
      const participant = createParticipant({ github_refresh_token_encrypted: null });

      const result = await harness.service.refreshToken(participant);

      expect(result).toBeNull();
      expect(harness.log.warn).toHaveBeenCalledWith(
        "Cannot refresh: no refresh token stored",
        expect.any(Object)
      );
    });

    it("returns null when GitHub OAuth credentials not configured", async () => {
      const h = createTestHarness({
        env: { GITHUB_CLIENT_ID: undefined, GITHUB_CLIENT_SECRET: undefined },
      });
      const participant = createParticipant({
        github_refresh_token_encrypted: "encrypted-refresh",
      });

      const result = await h.service.refreshToken(participant);

      expect(result).toBeNull();
      expect(h.log.warn).toHaveBeenCalledWith(
        "Cannot refresh: GitHub OAuth credentials not configured"
      );
    });
  });

  describe("resolveAuthForPR", () => {
    it("returns auth: null when participant has no OAuth token", async () => {
      const participant = createParticipant({ github_access_token_encrypted: null });

      const result = await harness.service.resolveAuthForPR(participant);

      expect(result).toEqual({ auth: null });
      expect(harness.log.info).toHaveBeenCalledWith(
        "PR creation: prompting user has no OAuth token, using manual fallback",
        expect.any(Object)
      );
    });

    it("returns error when token expired and no refresh token", async () => {
      const participant = createParticipant({
        github_access_token_encrypted: "encrypted-access",
        github_refresh_token_encrypted: null,
        github_token_expires_at: Date.now() - 1000,
      });

      const result = await harness.service.resolveAuthForPR(participant);

      expect(result).toEqual(expect.objectContaining({ error: expect.any(String), status: 401 }));
    });
  });
});
