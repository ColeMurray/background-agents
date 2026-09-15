import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Logger } from "../logger";
import type { ParticipantRow } from "./types";
import {
  ParticipantService,
  getAvatarUrl,
  type ParticipantServiceDeps,
  type ParticipantServiceEnv,
} from "./participant-service";
import type { ParticipantRepository } from "./participant-repository";
import { BetterAuthGitHubTokenUnavailableError } from "./identity";

// ---- Module-level mocks for local refresh tests ----

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
import { decryptToken } from "../auth/crypto";

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
    auth_name: null,
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

function createMockRepository() {
  return {
    getParticipantByUserId: vi.fn<() => ParticipantRow | null>(() => null),
    getParticipantByWsTokenHash: vi.fn<() => ParticipantRow | null>(() => null),
    getParticipantById: vi.fn<() => ParticipantRow | null>(() => null),
    getProcessingMessageAuthor: vi.fn<() => { author_id: string } | null>(() => null),
    createParticipant: vi.fn(),
    updateParticipantTokens: vi.fn(),
  };
}

function createTestHarness(overrides?: {
  env?: Partial<ParticipantServiceEnv>;
  resolveCurrentGitHubAccessToken?: ParticipantServiceDeps["resolveCurrentGitHubAccessToken"];
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
  const resolveCurrentGitHubAccessToken =
    overrides?.resolveCurrentGitHubAccessToken ?? vi.fn(async () => null);

  const deps: ParticipantServiceDeps = {
    repository: repository as unknown as ParticipantRepository,
    getProcessingMessageAuthor: repository.getProcessingMessageAuthor,
    env,
    log,
    generateId: () => `gen-id-${++idCounter}`,
    resolveCurrentGitHubAccessToken,
  };

  return {
    service: new ParticipantService(deps),
    repository,
    log,
    env,
    resolveCurrentGitHubAccessToken,
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

  it("uses the stable GitHub avatar endpoint when a numeric user ID is available", () => {
    expect(getAvatarUrl("open-inspect[bot]", "github", "255062780")).toBe(
      "https://avatars.githubusercontent.com/u/255062780?v=4"
    );
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

  describe("refreshToken", () => {
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

    it("refreshes credentials copied into an existing participant", async () => {
      const participant = createParticipant({
        scm_user_id: "42",
        scm_refresh_token_encrypted: "enc:old-refresh",
      });
      vi.mocked(refreshAccessToken).mockResolvedValue({
        access_token: "new-access",
        refresh_token: "new-refresh",
        token_type: "bearer",
        scope: "repo",
        expires_in: 28800,
      });
      const refreshedParticipant = createParticipant({
        scm_user_id: "42",
        scm_access_token_encrypted: "enc:new-access",
      });
      vi.mocked(harness.repository.getParticipantById).mockReturnValue(refreshedParticipant);

      await expect(harness.service.refreshToken(participant)).resolves.toBe(refreshedParticipant);

      expect(refreshAccessToken).toHaveBeenCalledWith("old-refresh", expect.any(Object));
      expect(harness.repository.updateParticipantTokens).toHaveBeenCalledWith("part-1", {
        scmAccessTokenEncrypted: "enc:new-access",
        scmRefreshTokenEncrypted: "enc:new-refresh",
        scmTokenExpiresAt: expect.any(Number),
      });
    });
  });

  describe("resolveAuthForPR", () => {
    it("uses a current Better Auth token for the canonical GitHub user", async () => {
      const resolveCurrentGitHubAccessToken = vi.fn(async () => "current-access-token");
      const h = createTestHarness({ resolveCurrentGitHubAccessToken });
      const participant = createParticipant({
        canonical_user_id: "user-1",
        scm_user_id: "42",
        scm_access_token_encrypted: null,
      });

      await expect(h.service.resolveAuthForPR(participant)).resolves.toEqual({
        auth: { authType: "oauth", token: "current-access-token" },
      });
      expect(resolveCurrentGitHubAccessToken).toHaveBeenCalledWith("user-1", "42");
    });

    it("uses a pre-cutover participant token without consulting Better Auth", async () => {
      const resolveCurrentGitHubAccessToken = vi.fn(async () => {
        throw new Error("Better Auth unavailable");
      });
      const h = createTestHarness({ resolveCurrentGitHubAccessToken });
      const participant = createParticipant({
        canonical_user_id: "user-1",
        scm_user_id: "42",
        scm_access_token_encrypted: "enc:existing-access-token",
        scm_refresh_token_encrypted: "enc:existing-refresh-token",
      });

      await expect(h.service.resolveAuthForPR(participant)).resolves.toEqual({
        auth: { authType: "oauth", token: "existing-access-token" },
      });
      expect(resolveCurrentGitHubAccessToken).not.toHaveBeenCalled();
    });

    it("treats access-token presence as an explicit pre-cutover participant", async () => {
      const resolveCurrentGitHubAccessToken = vi.fn(async () => null);
      const h = createTestHarness({ resolveCurrentGitHubAccessToken });
      const participant = createParticipant({
        canonical_user_id: "user-1",
        scm_user_id: "42",
        scm_access_token_encrypted: "enc:cached-access-token",
        scm_refresh_token_encrypted: null,
      });

      await expect(h.service.resolveAuthForPR(participant)).resolves.toEqual({
        auth: { authType: "oauth", token: "cached-access-token" },
      });
      expect(resolveCurrentGitHubAccessToken).not.toHaveBeenCalled();
    });

    it("fails closed when current credential integrity validation fails", async () => {
      const resolveCurrentGitHubAccessToken = vi.fn(async () => {
        throw new Error("GitHub account does not match");
      });
      const h = createTestHarness({ resolveCurrentGitHubAccessToken });
      const participant = createParticipant({
        canonical_user_id: "user-1",
        scm_user_id: "42",
      });

      await expect(h.service.resolveAuthForPR(participant)).resolves.toEqual({
        error: "Failed to resolve GitHub credentials",
        status: 500,
      });
    });

    it("logs Better Auth retrieval failures before using app fallback", async () => {
      const retrievalError = new Error("Access token not found");
      const h = createTestHarness({
        resolveCurrentGitHubAccessToken: vi.fn(async () => {
          throw new BetterAuthGitHubTokenUnavailableError(retrievalError);
        }),
      });
      const participant = createParticipant({
        canonical_user_id: "user-1",
        scm_user_id: "42",
      });

      await expect(h.service.resolveAuthForPR(participant)).resolves.toEqual({ auth: null });
      expect(h.log.warn).toHaveBeenCalledWith(
        "Better Auth GitHub token retrieval failed, using app fallback",
        { user_id: "user-1", error: retrievalError }
      );
    });

    it("returns auth: null when participant has no OAuth token", async () => {
      const participant = createParticipant({ scm_access_token_encrypted: null });

      const result = await harness.service.resolveAuthForPR(participant);

      expect(result).toEqual({ auth: null });
      expect(harness.log.info).toHaveBeenCalledWith(
        "PR creation: prompting user has no OAuth token, using app fallback",
        expect.any(Object)
      );
    });

    it("returns auth: null when token expired and refresh fails (falls back to app token)", async () => {
      const participant = createParticipant({
        scm_access_token_encrypted: "enc:encrypted-access",
        scm_refresh_token_encrypted: null,
        scm_token_expires_at: Date.now() - 1000,
      });

      const result = await harness.service.resolveAuthForPR(participant);

      expect(result).toEqual({ auth: null });
      expect(harness.log.warn).toHaveBeenCalledWith(
        "SCM token expired and refresh failed, falling back to app token",
        expect.any(Object)
      );
    });

    it("returns auth: null when token decryption fails (falls back to app token)", async () => {
      const participant = createParticipant({
        scm_access_token_encrypted: "enc:encrypted-access",
        scm_refresh_token_encrypted: null,
        scm_token_expires_at: null, // not expired — goes straight to decrypt
      });

      vi.mocked(decryptToken).mockRejectedValueOnce(new Error("bad key"));

      const result = await harness.service.resolveAuthForPR(participant);

      expect(result).toEqual({ auth: null });
      expect(harness.log.error).toHaveBeenCalledWith(
        "Failed to decrypt SCM token for PR creation, falling back to app token",
        expect.any(Object)
      );
    });
  });
});
