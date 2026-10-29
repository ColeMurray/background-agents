import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMISSION_POLICY_MAX_BODY_BYTES,
  admissionPolicySnapshotSchema,
  emptyAdmissionRules,
  type AdmissionPolicySnapshot,
  type StoredAdmissionPolicy,
} from "@open-inspect/shared/admission-settings";
import type * as AuthenticateModule from "../auth/authenticate";
import {
  authorizationDatabase,
  contractFor,
  createTestRequestHandler,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import type { Env } from "../types";
import { admissionPolicyRoutes } from "./settings-admission-policy";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), get: vi.fn(), replace: vi.fn() }));
vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));
vi.mock("../db/admission-policy-store", () => ({
  AdmissionPolicyStore: vi.fn().mockImplementation(function () {
    return { get: mocks.get, replace: mocks.replace };
  }),
}));

const handleRequest = createTestRequestHandler([admissionPolicyRoutes]);
let env: Env;
let policy: StoredAdmissionPolicy;

function call(method = "GET", body?: string, ifMatch?: string) {
  return handleRequest(
    new Request("https://test.local/settings/admission-policy", {
      method,
      body,
      headers: {
        "Content-Type": "application/json",
        ...(ifMatch === undefined ? {} : { "If-Match": ifMatch }),
      },
    }),
    env,
    TEST_BACKGROUND_TASK_CONTEXT
  );
}
async function snapshot(): Promise<AdmissionPolicySnapshot> {
  const response = await call();
  expect(response.status).toBe(200);
  return admissionPolicySnapshotSchema.parse(await response.json());
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticate.mockImplementation(async (request: Request) => ({
    principal: { kind: "user", userId: "user-1" },
    request,
  }));
  env = {
    ...TEST_SERVICE_SECRETS,
    DB: authorizationDatabase(),
    GITHUB_CLIENT_ID: "github-id",
    GITHUB_CLIENT_SECRET: "github-secret",
    ALLOWED_EMAILS: "recovery@example.com",
  } as Env;
  policy = {
    rules: emptyAdmissionRules(),
    rulesJson: JSON.stringify(emptyAdmissionRules()),
    revision: 0,
    updatedAt: null,
    updatedByUserId: null,
  };
  mocks.get.mockImplementation(async () => policy);
  mocks.replace.mockImplementation(async ({ rules }) => ({
    status: "applied",
    policy: {
      ...policy,
      rules,
      revision: policy.revision + 1,
      updatedAt: 123,
      updatedByUserId: "user-1",
    },
  }));
});

describe("admission policy settings routes", () => {
  it.each(["GET", "PUT"])(
    "registers %s as human-only management in the route catalog",
    (method) => {
      expect(contractFor(method, "/settings/admission-policy")).toMatchObject({
        authentication: { kind: "user" },
        authorization: {
          kind: "active-user",
          allOf: [{ kind: "permission", permission: "workspace.members.manage" }],
          service: { kind: "deny" },
        },
        cacheControl: "private, no-store",
      });
    }
  );

  it("returns strict source-preserving snapshots and private ETags without secrets", async () => {
    env.ALLOWED_EMAILS = " RECOVERY@example.com , recovery@example.com ";
    env.ALLOWED_EMAIL_DOMAINS = " legacy_local ";
    policy.rules.allowedEmails = ["recovery@example.com"];
    const response = await call();
    const body = admissionPolicySnapshotSchema.parse(await response.json());
    expect(body.deployment.allowedEmails).toEqual(["recovery@example.com"]);
    expect(body.managed.allowedEmails).toEqual(["recovery@example.com"]);
    expect(body.effective.allowedEmails).toEqual(["recovery@example.com"]);
    expect(body.deployment.allowedEmailDomains).toEqual(["legacy_local"]);
    expect(body.enabledProviders).toEqual(["github"]);
    expect(response.headers.get("etag")).toBe(body.etag);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.stringify(body)).not.toContain("github-secret");
  });

  it("canonicalizes deployment ETags but excludes credential secret rotation", async () => {
    env.ALLOWED_USERS = " Zed, Alice, Alice ";
    const before = await snapshot();
    env.ALLOWED_USERS = "alice,zed";
    env.GITHUB_CLIENT_SECRET = "rotated-secret";
    expect((await snapshot()).etag).toBe(before.etag);
  });

  it.each(["baseline", "provider", "unsafe"])("changes ETag for %s changes", async (change) => {
    const before = await snapshot();
    if (change === "baseline") env.ALLOWED_USERS = "new-user";
    if (change === "provider") {
      env.GOOGLE_CLIENT_ID = "google-id";
      env.GOOGLE_CLIENT_SECRET = "google-secret";
    }
    if (change === "unsafe") env.UNSAFE_ALLOW_ALL_USERS = "true";
    expect((await snapshot()).etag).not.toBe(before.etag);
  });

  it.each(["GET", "PUT"])(
    "denies %s by a custom member manager before reading policy",
    async (method) => {
      env.DB = authorizationDatabase({ permissions: ["workspace.members.manage"] });
      const response = await call(method, method === "PUT" ? "{}" : undefined);
      expect(response.status).toBe(403);
      expect(mocks.get).not.toHaveBeenCalled();
      expect(mocks.replace).not.toHaveBeenCalled();
    }
  );

  it.each([{ permissions: [] }, { permissions: ["workspace.members.read"] }] as const)(
    "denies non-management grants %j",
    async ({ permissions }) => {
      env.DB = authorizationDatabase({ permissions });
      expect((await call()).status).toBe(403);
      expect(mocks.get).not.toHaveBeenCalled();
    }
  );

  it("requires a single well-formed strong If-Match", async () => {
    expect((await call("PUT", "{}")).status).toBe(428);
    for (const tag of [
      "*",
      'W/"token"',
      '"token", "other"',
      `"admission-9007199254740992-${"a".repeat(64)}"`,
    ]) {
      expect((await call("PUT", "{}", tag)).status).toBe(400);
    }
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("rejects oversized streaming bodies before JSON parsing", async () => {
    const { etag } = await snapshot();
    expect((await call("PUT", "x".repeat(ADMISSION_POLICY_MAX_BODY_BYTES + 1), etag)).status).toBe(
      413
    );
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it.each([
    "{",
    "{}",
    JSON.stringify({ ...emptyAdmissionRules(), unsafeAllowAllUsers: true }),
    JSON.stringify({ ...emptyAdmissionRules(), allowedEmails: ["bad"] }),
  ])("rejects malformed or unsupported body %s", async (body) => {
    const { etag } = await snapshot();
    expect((await call("PUT", body, etag)).status).toBe(400);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("rejects changed deployment preconditions before mutation", async () => {
    const { etag } = await snapshot();
    env.ALLOWED_EMAILS = "other@example.com";
    expect((await call("PUT", JSON.stringify(emptyAdmissionRules()), etag)).status).toBe(412);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("passes stale revisions to transactional CAS, even for identical documents", async () => {
    const { etag } = await snapshot();
    policy.revision = 1;
    mocks.replace.mockResolvedValue({ status: "conflict", policy });
    expect((await call("PUT", JSON.stringify(emptyAdmissionRules()), etag)).status).toBe(412);
    expect(mocks.replace).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 0, before: policy })
    );
  });

  it("normalizes a replacement and returns the transaction's exact committed snapshot", async () => {
    const { etag } = await snapshot();
    const response = await call(
      "PUT",
      JSON.stringify({ ...emptyAdmissionRules(), allowedGitHubUsers: [" Zed ", "alice", "ALICE"] }),
      etag
    );
    expect(response.status).toBe(200);
    expect(mocks.replace).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "user-1",
        before: policy,
        expectedRevision: 0,
        rules: { ...emptyAdmissionRules(), allowedGitHubUsers: ["alice", "zed"] },
      })
    );
    const body = admissionPolicySnapshotSchema.parse(await response.json());
    expect(body.revision).toBe(1);
    expect(body.updatedAt).toBe(123);
    expect(body.etag).not.toBe(etag);
  });

  it("makes unsafe snapshots read-only and rejects edits", async () => {
    env.UNSAFE_ALLOW_ALL_USERS = " TRUE ";
    const body = await snapshot();
    expect(body.editingDisabledReason).toBe("unsafe_allow_all");
    expect(body.unsafeAllowAllEffective).toBe(false);
    expect((await call("PUT", JSON.stringify(emptyAdmissionRules()), body.etag)).status).toBe(409);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("reports unsafe effectiveness over the union, not just deployment rules", async () => {
    env.ALLOWED_EMAILS = "";
    env.UNSAFE_ALLOW_ALL_USERS = "true";
    expect((await snapshot()).unsafeAllowAllEffective).toBe(true);
    policy.rules.allowedEmails = ["managed@example.com"];
    expect((await snapshot()).unsafeAllowAllEffective).toBe(false);
  });

  it.each(["empty", "google-incompatible", "no-provider"])(
    "rejects an incompatible %s baseline",
    async (mode) => {
      if (mode === "empty") env.ALLOWED_EMAILS = "";
      if (mode === "google-incompatible") {
        env.ALLOWED_EMAILS = "";
        env.ALLOWED_USERS = "recovery";
        env.GOOGLE_CLIENT_ID = "id";
        env.GOOGLE_CLIENT_SECRET = "secret";
      }
      if (mode === "no-provider") env.GITHUB_CLIENT_SECRET = "";
      const { etag } = await snapshot();
      expect(
        (
          await call(
            "PUT",
            JSON.stringify({ ...emptyAdmissionRules(), allowedEmails: ["managed@example.com"] }),
            etag
          )
        ).status
      ).toBe(409);
      expect(mocks.replace).not.toHaveBeenCalled();
    }
  );

  it("bounds new organization fan-out but permits overlap and overlimit reductions or unrelated edits", async () => {
    env.ALLOWED_GITHUB_ORGS = Array.from({ length: 12 }, (_, i) => `org-${i}`).join(",");
    const { etag } = await snapshot();
    const rules = { ...emptyAdmissionRules(), allowedGitHubOrganizations: ["new-org"] };
    expect((await call("PUT", JSON.stringify(rules), etag)).status).toBe(409);
    expect(
      (await call("PUT", JSON.stringify({ ...rules, allowedGitHubOrganizations: ["org-0"] }), etag))
        .status
    ).toBe(200);
    policy.rules.allowedGitHubOrganizations = ["extra-a", "extra-b"];
    const next = await snapshot();
    expect(
      (
        await call(
          "PUT",
          JSON.stringify({ ...policy.rules, allowedEmails: ["new@example.com"] }),
          next.etag
        )
      ).status
    ).toBe(200);
    expect(
      (
        await call(
          "PUT",
          JSON.stringify({ ...rules, allowedGitHubOrganizations: ["extra-a"] }),
          next.etag
        )
      ).status
    ).toBe(200);
    expect(
      (
        await call(
          "PUT",
          JSON.stringify({
            ...rules,
            allowedGitHubOrganizations: ["extra-a", "extra-b", "extra-c"],
          }),
          next.etag
        )
      ).status
    ).toBe(409);
  });

  it.each([
    ["actor_authorization_changed", 403],
    ["unavailable", 503],
    ["no_op", 200],
  ] as const)("maps transactional %s to %i", async (status, expectedStatus) => {
    const { etag } = await snapshot();
    mocks.replace.mockResolvedValue({ status, policy });
    expect((await call("PUT", JSON.stringify(emptyAdmissionRules()), etag)).status).toBe(
      expectedStatus
    );
  });

  it("sanitizes read and transactional audit failures", async () => {
    const { etag } = await snapshot();
    mocks.replace.mockRejectedValue(new Error("private SQL details"));
    const response = await call("PUT", JSON.stringify(emptyAdmissionRules()), etag);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private SQL details");
    mocks.get.mockRejectedValue(new Error("invalid persisted policy"));
    expect((await call()).status).toBe(503);
  });
});
