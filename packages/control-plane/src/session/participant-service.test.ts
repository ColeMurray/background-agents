import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Logger } from "../logger";
import type { ParticipantRow } from "./types";
import {
  ParticipantService,
  getAvatarUrl,
  type ParticipantServiceDeps,
} from "./participant-service";
import type { ParticipantRepository } from "./participant-repository";
import { BetterAuthGitHubTokenUnavailableError } from "./identity";

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
  };
}

function createTestHarness(overrides?: {
  resolveCurrentGitHubAccessToken?: ParticipantServiceDeps["resolveCurrentGitHubAccessToken"];
}) {
  const log = createMockLogger();
  const repository = createMockRepository();
  let idCounter = 0;

  const resolveCurrentGitHubAccessToken =
    overrides?.resolveCurrentGitHubAccessToken ?? vi.fn(async () => null);

  const deps: ParticipantServiceDeps = {
    repository: repository as unknown as ParticipantRepository,
    getProcessingMessageAuthor: repository.getProcessingMessageAuthor,
    log,
    generateId: () => `gen-id-${++idCounter}`,
    resolveCurrentGitHubAccessToken,
  };

  return {
    service: new ParticipantService(deps),
    repository,
    log,
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

    it.each([
      {
        scm_access_token_encrypted: "enc:old-access",
        scm_refresh_token_encrypted: null,
        scm_token_expires_at: 1,
      },
      { scm_access_token_encrypted: null, scm_refresh_token_encrypted: "enc:old-refresh" },
      {
        scm_access_token_encrypted: "enc:old-access",
        scm_refresh_token_encrypted: "enc:old-refresh",
        scm_token_expires_at: 1,
      },
      {
        scm_access_token_encrypted: "enc:old-access",
        scm_refresh_token_encrypted: null,
        scm_token_expires_at: null,
      },
    ])(
      "uses current Better Auth credentials despite copied legacy fields: %j",
      async (legacyFields) => {
        const h = createTestHarness({
          resolveCurrentGitHubAccessToken: vi.fn(async () => "current-access-token"),
        });
        const participant = createParticipant({
          canonical_user_id: "user-1",
          scm_user_id: "42",
          ...legacyFields,
        });
        await expect(h.service.resolveAuthForPR(participant)).resolves.toEqual({
          auth: { authType: "oauth", token: "current-access-token" },
        });
      }
    );

    it.each(["missing canonical identity", "missing current grant", "identity mismatch"])(
      "never falls back to copied credentials on %s",
      async (failure) => {
        const h = createTestHarness({
          resolveCurrentGitHubAccessToken: vi.fn(async () => {
            if (failure === "identity mismatch") throw new Error("GitHub account does not match");
            return null;
          }),
        });
        const participant = createParticipant({
          canonical_user_id: failure === "missing canonical identity" ? null : "user-1",
          scm_user_id: "42",
          scm_access_token_encrypted: "enc:old-access",
          scm_refresh_token_encrypted: "enc:old-refresh",
        });
        await expect(h.service.resolveAuthForPR(participant)).resolves.toEqual(
          failure === "identity mismatch"
            ? { error: "Failed to resolve GitHub credentials", status: 500 }
            : { auth: null }
        );
      }
    );

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
  });
});
