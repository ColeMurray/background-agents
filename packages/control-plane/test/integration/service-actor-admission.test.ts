import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { UserStore } from "../../src/db/user-store";
import type { WorkerBindings } from "../../src/cloudflare/platform";
import { cleanD1Tables } from "./cleanup";
import { routeRequest, serviceRequestHeaders } from "./helpers";

async function actorRequest(
  provider: "slack" | "linear" | "github",
  profile: Record<string, unknown>,
  overrides: Partial<WorkerBindings> = {},
  path = "/actors/me"
): Promise<Response> {
  const url = `https://test.local${path}`;
  const body = JSON.stringify(profile);
  return routeRequest(
    new Request(url, {
      method: "POST",
      headers: await serviceRequestHeaders(url, {
        service: `${provider}-bot`,
        method: "POST",
        actor: `${provider}:new-actor`,
        body,
      }),
      body,
    }),
    {
      ...env,
      ALLOWED_USERS: "",
      ALLOWED_EMAILS: "",
      ALLOWED_EMAIL_DOMAINS: "corp.test",
      ALLOWED_GITHUB_ORGS: "",
      UNSAFE_ALLOW_ALL_USERS: "false",
      ...overrides,
    },
    createExecutionContext()
  );
}

async function expectNoEnrollment(): Promise<void> {
  for (const table of ["users", "user_identities", "user_role_assignments", "sessions"]) {
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).toEqual({
      count: 0,
    });
  }
}

describe.each(["slack", "linear"] as const)("%s actor admission", (provider) => {
  beforeEach(cleanD1Tables);

  it.each([
    ["exact email", { ALLOWED_EMAIL_DOMAINS: "", ALLOWED_EMAILS: " OTHER@test, ADA@CORP.TEST " }],
    ["email domain", { ALLOWED_EMAIL_DOMAINS: " CORP.TEST " }],
    ["explicit open access", { ALLOWED_EMAIL_DOMAINS: "", UNSAFE_ALLOW_ALL_USERS: " TRUE " }],
  ])("enrolls a new Member through %s", async (_name, settings) => {
    const response = await actorRequest(provider, { email: " Ada@Corp.Test " }, settings);
    expect(response.status).toBe(204);
    const users = new UserStore(env.DB);
    const user = await users.getUserByEmail("ada@corp.test");
    expect(user).toMatchObject({ emailVerified: true });
    expect(await users.getIdentity(provider, "new-actor")).toMatchObject({ userId: user!.id });
    expect(
      await env.DB.prepare("SELECT role_id FROM user_role_assignments WHERE user_id = ?")
        .bind(user!.id)
        .first()
    ).toEqual({ role_id: "role_builtin_member" });
  });

  it.each([
    ["an unrelated domain", "ada@elsewhere.test", {}],
    ["a subdomain", "ada@sub.corp.test", {}],
    ["a suffix lookalike", "ada@evilcorp.test", {}],
    [
      "an unmatched exact email",
      "other@corp.test",
      { ALLOWED_EMAIL_DOMAINS: "", ALLOWED_EMAILS: "ada@corp.test" },
    ],
    ["no admission settings", "ada@corp.test", { ALLOWED_EMAIL_DOMAINS: "" }],
    [
      "GitHub username only",
      "ada@corp.test",
      { ALLOWED_EMAIL_DOMAINS: "", ALLOWED_USERS: "new-actor" },
    ],
    [
      "GitHub organization only",
      "ada@corp.test",
      { ALLOWED_EMAIL_DOMAINS: "", ALLOWED_GITHUB_ORGS: "corp" },
    ],
    [
      "unsafe allow-all alongside an allowlist",
      "ada@elsewhere.test",
      { UNSAFE_ALLOW_ALL_USERS: "true" },
    ],
  ])(
    "refuses %s before writing a user, identity, role, or session",
    async (_name, email, settings) => {
      const response = await actorRequest(provider, { email }, settings);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "actor_admission_denied" });
      await expectNoEnrollment();
    }
  );

  it("enforces admission on session creation as well as explicit enrollment", async () => {
    const response = await actorRequest(
      provider,
      {
        title: "Unadmitted launch",
        model: "anthropic/claude-haiku-4-5",
        actorEmail: "ada@elsewhere.test",
      },
      {},
      "/sessions"
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "actor_admission_denied" });
    await expectNoEnrollment();
  });

  it("requires an attested email even with open access", async () => {
    const response = await actorRequest(
      provider,
      {},
      {
        ALLOWED_EMAIL_DOMAINS: "",
        UNSAFE_ALLOW_ALL_USERS: "true",
      }
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "actor_email_required" });
    await expectNoEnrollment();
  });

  it.each(["viewer", "suspended"])(
    "links an existing %s without changing its restrictions",
    async (restriction) => {
      const users = new UserStore(env.DB);
      const user = await users.createUser({ email: "ada@elsewhere.test", emailVerified: true });
      if (restriction === "viewer") {
        await env.DB.prepare(
          "UPDATE user_role_assignments SET role_id = 'role_builtin_viewer' WHERE user_id = ?"
        )
          .bind(user.id)
          .run();
      } else {
        await env.DB.prepare("UPDATE users SET suspended_at = 1 WHERE id = ?").bind(user.id).run();
      }

      const response = await actorRequest(
        provider,
        {
          title: "Restricted launch",
          model: "anthropic/claude-haiku-4-5",
          actorEmail: "ada@elsewhere.test",
        },
        {},
        "/sessions"
      );
      expect(response.status).toBe(403);
      expect(await users.getIdentity(provider, "new-actor")).toMatchObject({ userId: user.id });
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first()).toEqual({
        count: 1,
      });
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first()).toEqual({
        count: 0,
      });
      expect(
        await env.DB.prepare("SELECT role_id FROM user_role_assignments WHERE user_id = ?")
          .bind(user.id)
          .first()
      ).toEqual({
        role_id: restriction === "viewer" ? "role_builtin_viewer" : "role_builtin_member",
      });
    }
  );

  it("does not create a second Member for a restricted user's different, unadmitted email", async () => {
    const users = new UserStore(env.DB);
    const user = await users.createUser({ email: "web@corp.test" });
    await env.DB.prepare("UPDATE users SET suspended_at = 1 WHERE id = ?").bind(user.id).run();

    const response = await actorRequest(provider, { email: "slack@elsewhere.test" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "actor_admission_denied" });
    expect(await users.getIdentity(provider, "new-actor")).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first()).toEqual({
      count: 1,
    });
  });

  it("links a previously admitted user even when the allowlists no longer match", async () => {
    const users = new UserStore(env.DB);
    const user = await users.createUser({ email: "ada@elsewhere.test", emailVerified: true });
    expect((await actorRequest(provider, { email: "ada@elsewhere.test" })).status).toBe(204);
    expect(await users.getIdentity(provider, "new-actor")).toMatchObject({ userId: user.id });
  });

  it("admits known actors without reapplying admission or requiring an email", async () => {
    await new UserStore(env.DB).resolveOrCreateUser(
      {
        provider,
        providerUserId: "new-actor",
        providerEmail: "ada@elsewhere.test",
      },
      () => {}
    );
    expect((await actorRequest(provider, {})).status).toBe(204);
  });
});

describe("GitHub actor admission", () => {
  beforeEach(cleanD1Tables);

  it("does not treat a GitHub bot profile email as proof of admission", async () => {
    const response = await actorRequest("github", { email: "ada@corp.test" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "actor_admission_denied" });
    await expectNoEnrollment();
  });

  it("admits a known GitHub actor without requiring new admission evidence", async () => {
    await new UserStore(env.DB).resolveOrCreateUser(
      {
        provider: "github",
        providerUserId: "new-actor",
      },
      () => {}
    );
    expect((await actorRequest("github", {})).status).toBe(204);
  });
});
