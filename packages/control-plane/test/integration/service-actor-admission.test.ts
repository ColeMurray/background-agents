import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAdmissionRules, type AdmissionRules } from "@open-inspect/shared/admission-settings";
import { AdmissionPolicyStore } from "../../src/db/admission-policy-store";
import { UserStore } from "../../src/db/user-store";
import type { WorkerBindings } from "../../src/cloudflare/platform";
import { cleanD1Tables } from "./cleanup";
import { routeRequest, serviceRequestHeaders } from "./helpers";

async function actorRequest(
  provider: "slack" | "linear" | "github",
  profile: Record<string, unknown>,
  overrides: Partial<WorkerBindings> = {},
  path = "/actors/me",
  actorId = "new-actor"
): Promise<Response> {
  const url = `https://test.local${path}`;
  const body = JSON.stringify(profile);
  return routeRequest(
    new Request(url, {
      method: "POST",
      headers: await serviceRequestHeaders(url, {
        service: `${provider}-bot`,
        method: "POST",
        actor: `${provider}:${actorId}`,
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
      BROWSER_AUTH_SECRET: undefined,
      GITHUB_CLIENT_ID: undefined,
      GITHUB_CLIENT_SECRET: undefined,
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
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

async function setManagedRules(rules: Partial<AdmissionRules>): Promise<void> {
  await env.DB.prepare(
    "UPDATE workspace_admission_policy SET rules_json = ?, revision = revision + 1 WHERE id = 1"
  )
    .bind(JSON.stringify({ ...emptyAdmissionRules(), ...rules }))
    .run();
}

beforeEach(async () => {
  await cleanD1Tables();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO workspace_admission_policy (id, schema_version, revision, rules_json) VALUES (1, 1, 0, ?)"
  )
    .bind(JSON.stringify(emptyAdmissionRules()))
    .run();
});

afterEach(() => vi.restoreAllMocks());

describe.each(["slack", "linear"] as const)("%s actor admission", (provider) => {
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
    { name: "email", rules: { allowedEmails: ["ada@managed.test"] } },
    { name: "domain", rules: { allowedEmailDomains: ["managed.test"] } },
  ])(
    "reads a new managed $name grant without OAuth configuration or a restart",
    async ({ rules }) => {
      const policyRead = vi.spyOn(AdmissionPolicyStore.prototype, "get");
      const denied = await actorRequest(provider, { email: "ada@managed.test" });
      expect(denied.status).toBe(403);
      await expectNoEnrollment();

      await setManagedRules(rules);
      const admitted = await actorRequest(provider, { email: " Ada@Managed.Test " });
      expect(admitted.status).toBe(204);
      const users = new UserStore(env.DB);
      const user = await users.getUserByEmail("ada@managed.test");
      expect(user).toMatchObject({ emailVerified: true });
      expect(await users.getIdentity(provider, "new-actor")).toMatchObject({ userId: user!.id });
      expect(policyRead).toHaveBeenCalledTimes(2);
    }
  );

  it("applies managed-rule removal to new actors while retaining already enrolled actors", async () => {
    await setManagedRules({ allowedEmailDomains: ["managed.test"] });
    expect((await actorRequest(provider, { email: "ada@managed.test" })).status).toBe(204);
    await setManagedRules({});

    const denied = await actorRequest(
      provider,
      { email: "other@managed.test" },
      {},
      "/actors/me",
      "later-actor"
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "actor_admission_denied" });
    const users = new UserStore(env.DB);
    expect(await users.getIdentity(provider, "later-actor")).toBeNull();
    expect(await users.getUserByEmail("other@managed.test")).toBeNull();
    const policyRead = vi.spyOn(AdmissionPolicyStore.prototype, "get");
    expect((await actorRequest(provider, {})).status).toBe(204);
    expect(policyRead).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first()).toEqual({
      count: 1,
    });
  });

  it.each([
    { allowedEmails: ["other@managed.test"] },
    { allowedEmailDomains: ["managed.test"] },
    { allowedGitHubUsers: ["new-actor"] },
    { allowedGitHubOrganizations: ["corp"] },
  ])("never treats unsafe mode as open when managed rules are nonempty: %j", async (rules) => {
    await setManagedRules(rules);
    const response = await actorRequest(
      provider,
      { email: "ada@corp.test" },
      {
        ALLOWED_EMAIL_DOMAINS: "",
        UNSAFE_ALLOW_ALL_USERS: "true",
      }
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "actor_admission_denied" });
    await expectNoEnrollment();
  });

  it.each(["missing", "corrupt"] as const)(
    "fails closed on %s managed policy even with a deployment grant",
    async (failure) => {
      const sensitiveValue = "private-policy-data";
      if (failure === "missing") {
        await env.DB.prepare("DELETE FROM workspace_admission_policy WHERE id = 1").run();
      } else {
        await env.DB.prepare("UPDATE workspace_admission_policy SET rules_json = ? WHERE id = 1")
          .bind(sensitiveValue)
          .run();
      }
      const response = await actorRequest(provider, { email: "ada@corp.test" });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "Authorization unavailable",
        code: "authorization_unavailable",
      });
      await expectNoEnrollment();
      const audit = await env.DB.prepare(
        "SELECT metadata_json FROM authorization_audit_events"
      ).all();
      expect(JSON.stringify(audit.results)).not.toContain(sensitiveValue);
    }
  );

  it("does not fall back to unsafe allow-all when the policy row is missing", async () => {
    await env.DB.prepare("DELETE FROM workspace_admission_policy WHERE id = 1").run();
    const response = await actorRequest(
      provider,
      { email: "ada@corp.test" },
      {
        ALLOWED_EMAIL_DOMAINS: "",
        UNSAFE_ALLOW_ALL_USERS: "true",
      }
    );
    expect(response.status).toBe(503);
    await expectNoEnrollment();
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
      await env.DB.prepare("DELETE FROM workspace_admission_policy WHERE id = 1").run();
      const policyRead = vi.spyOn(AdmissionPolicyStore.prototype, "get");

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
      expect(policyRead).not.toHaveBeenCalled();
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

  it("links a previously admitted user without reading an unavailable policy", async () => {
    const users = new UserStore(env.DB);
    const user = await users.createUser({ email: "ada@elsewhere.test", emailVerified: true });
    await env.DB.prepare("DELETE FROM workspace_admission_policy WHERE id = 1").run();
    const policyRead = vi.spyOn(AdmissionPolicyStore.prototype, "get");
    expect((await actorRequest(provider, { email: "ada@elsewhere.test" })).status).toBe(204);
    expect(await users.getIdentity(provider, "new-actor")).toMatchObject({ userId: user.id });
    expect(policyRead).not.toHaveBeenCalled();
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
    await env.DB.prepare("DELETE FROM workspace_admission_policy WHERE id = 1").run();
    const policyRead = vi.spyOn(AdmissionPolicyStore.prototype, "get");
    expect((await actorRequest(provider, {})).status).toBe(204);
    expect(policyRead).not.toHaveBeenCalled();
  });
});

describe("GitHub actor admission", () => {
  it("does not treat a GitHub bot profile email as proof of admission", async () => {
    const response = await actorRequest("github", { email: "ada@corp.test" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "actor_admission_denied" });
    await expectNoEnrollment();
  });

  it("does not turn managed GitHub rules or unverified profile emails into bot evidence", async () => {
    await setManagedRules({
      allowedEmails: ["ada@managed.test"],
      allowedEmailDomains: ["managed.test"],
      allowedGitHubUsers: ["new-actor"],
      allowedGitHubOrganizations: ["corp"],
    });
    const response = await actorRequest(
      "github",
      { email: "ada@managed.test" },
      {
        ALLOWED_EMAIL_DOMAINS: "",
        UNSAFE_ALLOW_ALL_USERS: "true",
      }
    );
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
    await env.DB.prepare("DELETE FROM workspace_admission_policy WHERE id = 1").run();
    const policyRead = vi.spyOn(AdmissionPolicyStore.prototype, "get");
    expect((await actorRequest("github", {})).status).toBe(204);
    expect(policyRead).not.toHaveBeenCalled();
  });
});
