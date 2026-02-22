import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Logger } from "../logger";
import type { ParticipantRow } from "./types";
import {
  ParticipantService,
  getAvatarUrl,
  type ParticipantRepository,
  type ParticipantServiceDeps,
  type ParticipantServiceEnv,
} from "./participant-service";
import type { UserScmTokenStore, ScmTokenRecord, CasResult } from "../db/user-scm-tokens";

// ---- Module-level mocks for centralized refresh tests ----

vi.mock("../auth/crypto", () => ({
  encryptToken: vi.fn(async (token: string) => `enc:${token}`),
  decryptToken: vi.fn(async (encrypted: string) => {
    if (encrypted.startsWith("enc:")) return encrypted.slice(4);
    return `dec:${encrypted}`;
  }),
}));

vi.mock("../auth/github", () => ({
  refreshAccessToken: vi.fn(),
}));

import { refreshAccessToken } from "../auth/github";

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
    scm_user_id: null,
    scm_login: null,
    scm_email: null,
    scm_name: "Test User",
    scm_provider: "github",
    role: "member",
    scm_access_token_encrypted: null,
    scm_refresh_token_encrypted: null,
    scm_token_expires_at: null,
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
  };
}

function createMockUserScmTokenStore(): {
  store: UserScmTokenStore;
  getTokens: ReturnType<typeof vi.fn>;
  upsertTokens: ReturnType<typeof vi.fn>;
  casUpdateTokens: ReturnType<typeof vi.fn>;
  isTokenFresh: ReturnType<typeof vi.fn>;
} {
  const getTokens = vi.fn<(id: string) => Promise<ScmTokenRecord | null>>().mockResolvedValue(null);
  const upsertTokens = vi.fn().mockResolvedValue(undefined);
  const casUpdateTokens = vi
    .fn<
      (
        id: string,
        expected: string,
        newAccess: string,
        newRefresh: string,
        newExpires: number
      ) => Promise<CasResult>
    >()
    .mockResolvedValue({ ok: true });
  const isTokenFresh = vi
    .fn<(expiresAt: number, bufferMs?: number) => boolean>()
    .mockReturnValue(false);

  return {
    store: {
      getTokens,
      upsertTokens,
      casUpdateTokens,
      isTokenFresh,
    } as unknown as UserScmTokenStore,
    getTokens,
    upsertTokens,
    casUpdateTokens,
    isTokenFresh,
  };
}

function createTestHarness(overrides?: {
  env?: Partial<ParticipantServiceEnv>;
  userScmTokenStore?: UserScmTokenStore | null;
}) {
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
    userScmTokenStore: overrides?.userScmTokenStore,
  };

  return {
    service: new ParticipantService(deps),
    repository,
    log,
    env,
  };
}

// ---- Tests ----

describe("getAvatarUrl", () => {
  it("returns avatar URL for a GitHub login", () => {
    expect(getAvatarUrl("octocat")).toBe("https://github.com/octocat.png");
  });

  it("returns avatar URL with explicit github provider", () => {
    expect(getAvatarUrl("octocat", "github")).toBe("https://github.com/octocat.png");
  });

  it("returns undefined for null", () => {
    expect(getAvatarUrl(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(getAvatarUrl(undefined)).toBeUndefined();
  });

  it("returns undefined for unsupported provider", () => {
    expect(getAvatarUrl("user", "bitbucket")).toBeUndefined();
  });
});

describe("ParticipantService", () => {
  let harness: ReturnType<typeof createTestHarness>;

  beforeEach(() => {
    vi.clearAllMocks();
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
          scmName: "Alice",
          role: "member",
        })
      );
      expect(result.id).toBe("gen-id-1");
      expect(result.user_id).toBe("user-42");
      expect(result.scm_name).toBe("Alice");
      expect(result.role).toBe("member");
      expect(result.scm_access_token_encrypted).toBeNull();
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

  describe("isScmTokenExpired", () => {
    it("returns false when no expiry is set", () => {
      const participant = createParticipant({ scm_token_expires_at: null });
      expect(harness.service.isScmTokenExpired(participant)).toBe(false);
    });

    it("returns false when token is still valid", () => {
      const participant = createParticipant({
        scm_token_expires_at: Date.now() + 120000, // 2 minutes from now
      });
      expect(harness.service.isScmTokenExpired(participant)).toBe(false);
    });

    it("returns true when token is within default buffer", () => {
      const participant = createParticipant({
        scm_token_expires_at: Date.now() + 30000, // 30 seconds from now, within 60s buffer
      });
      expect(harness.service.isScmTokenExpired(participant)).toBe(true);
    });

    it("returns true when token is already expired", () => {
      const participant = createParticipant({
        scm_token_expires_at: Date.now() - 1000,
      });
      expect(harness.service.isScmTokenExpired(participant)).toBe(true);
    });

    it("respects custom buffer", () => {
      const participant = createParticipant({
        scm_token_expires_at: Date.now() + 30000,
      });
      // With 10s buffer, 30s remaining should NOT be expired
      expect(harness.service.isScmTokenExpired(participant, 10000)).toBe(false);
      // With 60s buffer, 30s remaining SHOULD be expired
      expect(harness.service.isScmTokenExpired(participant, 60000)).toBe(true);
    });
  });

  describe("refreshToken (local-only, no D1 store)", () => {
    it("returns null when no refresh token stored", async () => {
      const participant = createParticipant({ scm_refresh_token_encrypted: null });

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
        scm_refresh_token_encrypted: "enc:refresh-token",
      });

      const result = await h.service.refreshToken(participant);

      expect(result).toBeNull();
      expect(h.log.warn).toHaveBeenCalledWith("Cannot refresh: OAuth credentials not configured");
    });

    it("falls back to local when no scm_user_id even if store provided", async () => {
      const mockStore = createMockUserScmTokenStore();
      const h = createTestHarness({ userScmTokenStore: mockStore.store });

      const participant = createParticipant({
        scm_user_id: null,
        scm_refresh_token_encrypted: null,
      });

      await h.service.refreshToken(participant);

      // Should not call D1 store at all
      expect(mockStore.getTokens).not.toHaveBeenCalled();
    });

    it("falls back to local when userScmTokenStore is null", async () => {
      const h = createTestHarness({ userScmTokenStore: null });

      const participant = createParticipant({
        scm_user_id: "gh-123",
        scm_refresh_token_encrypted: null,
      });

      const result = await h.service.refreshToken(participant);

      expect(result).toBeNull();
    });
  });

  describe("refreshToken (centralized D1)", () => {
    let mockStore: ReturnType<typeof createMockUserScmTokenStore>;

    beforeEach(() => {
      mockStore = createMockUserScmTokenStore();
    });

    function createCentralizedHarness(overrides?: { env?: Partial<ParticipantServiceEnv> }) {
      return createTestHarness({
        userScmTokenStore: mockStore.store,
        ...overrides,
      });
    }

    it("uses fresh D1 access token without calling GitHub API", async () => {
      const h = createCentralizedHarness();
      const freshExpiresAt = Date.now() + 3600_000;

      mockStore.getTokens.mockResolvedValue({
        accessToken: "fresh-access",
        refreshToken: "fresh-refresh",
        expiresAt: freshExpiresAt,
        refreshTokenEncrypted: "enc-refresh",
      });
      mockStore.isTokenFresh.mockReturnValue(true);

      const updatedParticipant = createParticipant({
        scm_user_id: "gh-123",
        scm_access_token_encrypted: "enc:fresh-access",
        scm_refresh_token_encrypted: "enc:fresh-refresh",
        scm_token_expires_at: freshExpiresAt,
      });
      vi.mocked(h.repository.getParticipantById).mockReturnValue(updatedParticipant);

      const participant = createParticipant({ scm_user_id: "gh-123" });
      const result = await h.service.refreshToken(participant);

      expect(result).toBe(updatedParticipant);
      expect(mockStore.getTokens).toHaveBeenCalledWith("gh-123");
      expect(refreshAccessToken).not.toHaveBeenCalled();
      expect(h.repository.updateParticipantTokens).toHaveBeenCalledWith("part-1", {
        scmAccessTokenEncrypted: "enc:fresh-access",
        scmRefreshTokenEncrypted: "enc:fresh-refresh",
        scmTokenExpiresAt: freshExpiresAt,
      });
    });

    it("refreshes expired D1 token via GitHub API and CAS-writes", async () => {
      const h = createCentralizedHarness();

      mockStore.getTokens.mockResolvedValue({
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: Date.now() - 1000,
        refreshTokenEncrypted: "enc-old-refresh",
      });
      mockStore.isTokenFresh.mockReturnValue(false);
      mockStore.casUpdateTokens.mockResolvedValue({ ok: true });

      vi.mocked(refreshAccessToken).mockResolvedValue({
        access_token: "new-access",
        refresh_token: "new-refresh",
        token_type: "bearer",
        scope: "repo",
        expires_in: 28800,
      });

      const updatedParticipant = createParticipant({
        scm_user_id: "gh-123",
        scm_access_token_encrypted: "enc:new-access",
      });
      vi.mocked(h.repository.getParticipantById).mockReturnValue(updatedParticipant);

      const participant = createParticipant({ scm_user_id: "gh-123" });
      const result = await h.service.refreshToken(participant);

      expect(result).toBe(updatedParticipant);
      expect(refreshAccessToken).toHaveBeenCalledWith("old-refresh", expect.any(Object));
      expect(mockStore.casUpdateTokens).toHaveBeenCalledWith(
        "gh-123",
        "enc-old-refresh",
        "new-access",
        "new-refresh",
        expect.any(Number)
      );
    });

    it("on CAS conflict, re-reads D1 and uses winner's tokens", async () => {
      const h = createCentralizedHarness();

      mockStore.getTokens
        .mockResolvedValueOnce({
          accessToken: "old-access",
          refreshToken: "old-refresh",
          expiresAt: Date.now() - 1000,
          refreshTokenEncrypted: "enc-old-refresh",
        })
        .mockResolvedValueOnce({
          accessToken: "winner-access",
          refreshToken: "winner-refresh",
          expiresAt: Date.now() + 3600_000,
          refreshTokenEncrypted: "enc-winner-refresh",
        });
      mockStore.isTokenFresh.mockReturnValue(false);
      mockStore.casUpdateTokens.mockResolvedValue({ ok: false, reason: "cas_conflict" });

      vi.mocked(refreshAccessToken).mockResolvedValue({
        access_token: "my-new-access",
        refresh_token: "my-new-refresh",
        token_type: "bearer",
        scope: "repo",
        expires_in: 28800,
      });

      const updatedParticipant = createParticipant({
        scm_user_id: "gh-123",
        scm_access_token_encrypted: "enc:winner-access",
      });
      vi.mocked(h.repository.getParticipantById).mockReturnValue(updatedParticipant);

      const participant = createParticipant({ scm_user_id: "gh-123" });
      const result = await h.service.refreshToken(participant);

      expect(result).toBe(updatedParticipant);
      // Should have re-read D1
      expect(mockStore.getTokens).toHaveBeenCalledTimes(2);
      // Should update local with winner's tokens
      expect(h.repository.updateParticipantTokens).toHaveBeenCalledWith("part-1", {
        scmAccessTokenEncrypted: "enc:winner-access",
        scmRefreshTokenEncrypted: "enc:winner-refresh",
        scmTokenExpiresAt: expect.any(Number),
      });
    });

    it("falls back to local refresh when no D1 record, then seeds D1", async () => {
      const h = createCentralizedHarness();

      mockStore.getTokens.mockResolvedValue(null);

      vi.mocked(refreshAccessToken).mockResolvedValue({
        access_token: "local-new-access",
        refresh_token: "local-new-refresh",
        token_type: "bearer",
        scope: "repo",
        expires_in: 28800,
      });

      const refreshedParticipant = createParticipant({
        id: "part-1",
        scm_user_id: "gh-123",
        scm_access_token_encrypted: "enc:local-new-access",
        scm_refresh_token_encrypted: "enc:local-new-refresh",
        scm_token_expires_at: Date.now() + 28800_000,
      });
      vi.mocked(h.repository.getParticipantById).mockReturnValue(refreshedParticipant);

      const participant = createParticipant({
        scm_user_id: "gh-123",
        scm_refresh_token_encrypted: "enc:old-refresh",
      });
      const result = await h.service.refreshToken(participant);

      expect(result).toBe(refreshedParticipant);
      expect(h.log.info).toHaveBeenCalledWith(
        "No D1 token record, falling back to local refresh",
        expect.any(Object)
      );
      // Should seed D1 after successful local refresh
      expect(mockStore.upsertTokens).toHaveBeenCalledWith(
        "gh-123",
        "local-new-access",
        "local-new-refresh",
        expect.any(Number)
      );
    });

    it("D1 error falls back to local refresh", async () => {
      const h = createCentralizedHarness();

      mockStore.getTokens.mockRejectedValue(new Error("D1 unavailable"));

      vi.mocked(refreshAccessToken).mockResolvedValue({
        access_token: "fallback-access",
        refresh_token: "fallback-refresh",
        token_type: "bearer",
        scope: "repo",
        expires_in: 28800,
      });

      const refreshedParticipant = createParticipant({
        scm_user_id: "gh-123",
        scm_access_token_encrypted: "enc:fallback-access",
      });
      vi.mocked(h.repository.getParticipantById).mockReturnValue(refreshedParticipant);

      const participant = createParticipant({
        scm_user_id: "gh-123",
        scm_refresh_token_encrypted: "enc:old-refresh",
      });
      const result = await h.service.refreshToken(participant);

      expect(result).toBe(refreshedParticipant);
      expect(h.log.error).toHaveBeenCalledWith(
        "Centralized token refresh failed, falling back to local",
        expect.any(Object)
      );
    });

    it("returns null when D1 token expired and no GitHub OAuth credentials", async () => {
      const h = createCentralizedHarness({
        env: { GITHUB_CLIENT_ID: undefined, GITHUB_CLIENT_SECRET: undefined },
      });

      mockStore.getTokens.mockResolvedValue({
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: Date.now() - 1000,
        refreshTokenEncrypted: "enc-old-refresh",
      });
      mockStore.isTokenFresh.mockReturnValue(false);

      const participant = createParticipant({ scm_user_id: "gh-123" });
      const result = await h.service.refreshToken(participant);

      expect(result).toBeNull();
    });
  });

  describe("resolveAuthForPR", () => {
    it("returns auth: null when participant has no OAuth token", async () => {
      const participant = createParticipant({ scm_access_token_encrypted: null });

      const result = await harness.service.resolveAuthForPR(participant);

      expect(result).toEqual({ auth: null });
      expect(harness.log.info).toHaveBeenCalledWith(
        "PR creation: prompting user has no OAuth token, using manual fallback",
        expect.any(Object)
      );
    });

    it("returns error when token expired and no refresh token", async () => {
      const participant = createParticipant({
        scm_access_token_encrypted: "enc:encrypted-access",
        scm_refresh_token_encrypted: null,
        scm_token_expires_at: Date.now() - 1000,
      });

      const result = await harness.service.resolveAuthForPR(participant);

      expect(result).toEqual(expect.objectContaining({ error: expect.any(String), status: 401 }));
    });
  });
});
