import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyIdentityEnforcement,
  deriveIdentity,
  mayAttachCallbackContext,
  resolveCanonicalUserId,
} from "./identity-enforcement";
import type { Principal, ResolvedIdentity } from "./principal";
import type { UserStore } from "../db/user-store";
import type { RequestContext } from "../routes/shared";
import { TEST_BACKGROUND_TASK_CONTEXT } from "../router.test-support";

const USER_PRINCIPAL: Principal = {
  kind: "user",
  userId: "canon-1",
};

const SLACK_ACTOR: ResolvedIdentity = {
  provider: "slack",
  providerUserId: "U0123",
  canonicalUserId: "canon-2",
  participantUserId: "slack:U0123",
};

const SLACK_BOT_PRINCIPAL: Principal = {
  kind: "service",
  service: "slack-bot",
  actor: SLACK_ACTOR,
};

function createCtx(principal?: Principal): RequestContext {
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => ({ active: 1 })),
  };
  return {
    trace_id: "trace-test",
    request_id: "req-test",
    principal,
    db: { prepare: vi.fn(() => statement) },
    executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
  } as unknown as RequestContext;
}

function loggedEvents(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return spy.mock.calls.map(
    ([message]: unknown[]) => JSON.parse(String(message)) as Record<string, unknown>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deriveIdentity", () => {
  it("derives web users as themselves with spawnSource user", () => {
    expect(deriveIdentity(USER_PRINCIPAL)).toEqual({
      participantUserId: "canon-1",
      canonicalUserId: "canon-1",
      actor: null,
      spawnSource: "user",
    });
  });

  it("derives bot principals from their asserted actor", () => {
    expect(deriveIdentity(SLACK_BOT_PRINCIPAL)).toEqual({
      participantUserId: "slack:U0123",
      canonicalUserId: "canon-2",
      actor: SLACK_ACTOR,
      spawnSource: "slack-bot",
    });
  });

  it("derives nothing for sandbox and absent principals", () => {
    expect(deriveIdentity({ kind: "sandbox", sessionId: "s1" })).toBeNull();
    expect(deriveIdentity(undefined)).toBeNull();
  });

  it("derives an actorless bot principal with a null participant", () => {
    expect(deriveIdentity({ kind: "service", service: "slack-bot", actor: null })).toEqual({
      participantUserId: null,
      canonicalUserId: null,
      actor: null,
      spawnSource: "slack-bot",
    });
  });
});

describe("applyIdentityEnforcement — identityless principals", () => {
  it("403s sandbox and absent principals rather than proceeding identityless", () => {
    for (const principal of [undefined, { kind: "sandbox", sessionId: "s1" } as const]) {
      const { rejection } = applyIdentityEnforcement(createCtx(principal), "prompt", {});
      expect(rejection?.status).toBe(403);
    }
  });
});

describe("applyIdentityEnforcement — forbidden-field rejection", () => {
  it("accepts bodies carrying only permitted fields", () => {
    expect(
      applyIdentityEnforcement(createCtx(USER_PRINCIPAL), "session-create", {
        scmLogin: "ada",
        actorDisplayName: "Ada",
        title: "display fields stay body-carried",
      }).rejection
    ).toBeUndefined();
  });

  it("rejects every spawning-route identity and credential field", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const route of ["session-create", "automation-create"] as const) {
      for (const field of [
        "userId",
        "spawnSource",
        "authProvider",
        "authUserId",
        "actorUserId",
        "scmToken",
        "scmRefreshToken",
        "scmUserId",
      ]) {
        const { rejection } = applyIdentityEnforcement(createCtx(USER_PRINCIPAL), route, {
          [field]: "asserted",
        });
        expect(rejection?.status).toBe(400);
      }
    }
  });

  it("never logs token values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    applyIdentityEnforcement(createCtx(USER_PRINCIPAL), "session-create", {
      scmToken: "gho_supersecret",
    });
    for (const [message] of warn.mock.calls) {
      expect(String(message)).not.toContain("gho_supersecret");
    }
  });

  it("treats non-object bodies as bodyless", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const rawBody of [null, undefined, "string", 42, ["array"]]) {
      const result = applyIdentityEnforcement(createCtx(USER_PRINCIPAL), "prompt", rawBody);
      expect(result.rejection).toBeUndefined();
    }
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("applyIdentityEnforcement — enforced identity", () => {
  it("derives from the verified principal", () => {
    expect(
      applyIdentityEnforcement(createCtx(USER_PRINCIPAL), "prompt", {}).enforced
    ).toMatchObject({ participantUserId: "canon-1" });
    expect(
      applyIdentityEnforcement(createCtx(SLACK_BOT_PRINCIPAL), "session-create", {}).enforced
    ).toMatchObject({ participantUserId: "slack:U0123", spawnSource: "slack-bot" });
  });
});

describe("applyIdentityEnforcement — requires-user rejection", () => {
  // Derives a non-null identity with no participant: the bot asserted no actor.
  const ACTORLESS_BOT: Principal = {
    kind: "service",
    service: "slack-bot",
    actor: null,
  };

  it.each([
    ["session-create", "A user identity is required to create a session"],
    ["ws-token", "A user identity is required for a websocket token"],
    ["automation-create", "A user identity is required to create an automation"],
  ] as const)("403s %s when the principal derives no participant", async (route, message) => {
    const { rejection } = applyIdentityEnforcement(createCtx(ACTORLESS_BOT), route, {});
    expect(rejection).toBeDefined();
    expect(rejection!.status).toBe(403);
    expect(((await rejection!.clone().json()) as { error: string }).error).toBe(message);
  });

  it("does not gate routes that accept participantless principals", () => {
    const result = applyIdentityEnforcement(createCtx(ACTORLESS_BOT), "prompt", {});
    expect(result.rejection).toBeUndefined();
    expect(result.enforced).toMatchObject({ participantUserId: null });
  });
});

describe("resolveCanonicalUserId", () => {
  const display = { displayName: "Dana", email: "d@example.com" };

  it("returns the canonical id directly when the principal already resolved", async () => {
    const userStore = { resolveOrCreateUser: vi.fn() } as unknown as UserStore;
    const result = await resolveCanonicalUserId(
      userStore,
      createCtx(USER_PRINCIPAL),
      {
        participantUserId: "canon-1",
        canonicalUserId: "canon-1",
        actor: null,
        spawnSource: "user",
      },
      display
    );
    expect(result).toEqual({ userId: "canon-1" });
  });

  it("creates the user from the VERIFIED actor when unseen", async () => {
    const resolveOrCreateUser = vi.fn(async () => ({ id: "canon-new" }));
    const userStore = { resolveOrCreateUser } as unknown as UserStore;
    const result = await resolveCanonicalUserId(
      userStore,
      createCtx(SLACK_BOT_PRINCIPAL),
      {
        participantUserId: "slack:U0123",
        canonicalUserId: null,
        actor: SLACK_ACTOR,
        spawnSource: "slack-bot",
      },
      display
    );
    expect(result).toEqual({ userId: "canon-new" });
    expect(resolveOrCreateUser).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "slack", providerUserId: "U0123", displayName: "Dana" })
    );
  });

  it("rejects when actor enrichment relinks to a different authorized user", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ctx = createCtx(SLACK_BOT_PRINCIPAL);
    ctx.authorization = {
      userId: "canon-provisional",
      suspendedAt: null,
      permissions: ["sessions.create"],
      role: { id: "role-member", key: "member", name: "Member" },
    };
    const result = await resolveCanonicalUserId(
      {
        resolveOrCreateUser: vi.fn(async () => ({ id: "canon-existing" })),
      } as unknown as UserStore,
      ctx,
      {
        participantUserId: "slack:U0123",
        canonicalUserId: null,
        actor: SLACK_ACTOR,
        spawnSource: "slack-bot",
      },
      display
    );

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(409);
    await expect((result as Response).json()).resolves.toMatchObject({
      code: "actor_identity_changed",
    });
    expect(loggedEvents(warn)).toContainEqual(
      expect.objectContaining({
        event: "identity.mismatch_rejected",
        expected: "canon-provisional",
        actual: "canon-existing",
      })
    );
  });

  it("rejects a canonical identity whose workspace access is suspended", async () => {
    const ctx = createCtx(USER_PRINCIPAL);
    const statement = {
      bind: vi.fn(() => statement),
      first: vi.fn(async () => null),
    };
    ctx.db = { prepare: vi.fn(() => statement) } as never;

    const result = await resolveCanonicalUserId(
      { resolveOrCreateUser: vi.fn() } as unknown as UserStore,
      ctx,
      {
        participantUserId: "canon-1",
        canonicalUserId: "canon-1",
        actor: null,
        spawnSource: "user",
      },
      display
    );

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
  });

  it("fails closed with a 500 if a participant ever lacks both a canonical user and an actor", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const userStore = { resolveOrCreateUser: vi.fn() } as unknown as UserStore;
    const result = await resolveCanonicalUserId(
      userStore,
      createCtx(SLACK_BOT_PRINCIPAL),
      {
        participantUserId: "slack:U0123",
        canonicalUserId: null,
        actor: null,
        spawnSource: "slack-bot",
      },
      display
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(500);
    expect(userStore.resolveOrCreateUser).not.toHaveBeenCalled();
  });

  it("fails closed with a 500 when resolution throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const userStore = {
      resolveOrCreateUser: vi.fn(async () => {
        throw new Error("d1 down");
      }),
    } as unknown as UserStore;
    const result = await resolveCanonicalUserId(
      userStore,
      createCtx(SLACK_BOT_PRINCIPAL),
      {
        participantUserId: "slack:U0123",
        canonicalUserId: null,
        actor: SLACK_ACTOR,
        spawnSource: "slack-bot",
      },
      display
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(500);
  });
});

describe("mayAttachCallbackContext", () => {
  it("restricts callbackContext to callback-owning bots", () => {
    expect(mayAttachCallbackContext(createCtx(SLACK_BOT_PRINCIPAL))).toBe(true);
    expect(
      mayAttachCallbackContext(createCtx({ kind: "service", service: "linear-bot", actor: null }))
    ).toBe(true);
    expect(mayAttachCallbackContext(createCtx(USER_PRINCIPAL))).toBe(false);
    expect(
      mayAttachCallbackContext(createCtx({ kind: "service", service: "github-bot", actor: null }))
    ).toBe(false);
    expect(mayAttachCallbackContext(createCtx(undefined))).toBe(false);
  });
});
