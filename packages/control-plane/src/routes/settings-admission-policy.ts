import {
  ADMISSION_POLICY_MAX_BODY_BYTES,
  MAX_MANAGED_ADMISSION_ORGANIZATIONS,
  admissionRulesSchema,
  mergeAdmissionRules,
  type AdmissionPolicySnapshot,
  type AdmissionRules,
  type StoredAdmissionPolicy,
} from "@open-inspect/shared/admission-settings";
import { readBodyCapped } from "@open-inspect/shared/http-body";
import { BUILT_IN_ROLE_REGISTRY, isWorkspaceAdmin } from "@open-inspect/shared/rbac";
import { Hono } from "hono";
import {
  AdmissionPolicy,
  parseAdmissionAllowlist,
  parseAdmissionBoolean,
} from "../auth/user/admission-policy";
import { AdmissionPolicyStore } from "../db/admission-policy-store";
import { createLogger } from "../logger";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import {
  json,
  requirePermission,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  type UserRouteContext,
} from "./shared";

const logger = createLogger("router:admission-policy");

function failure(code: string, status: number): Response {
  return json({ error: "Admission policy request failed", code }, status);
}

function isAdministrator(ctx: UserRouteContext): boolean {
  const authorization = ctx.authorization;
  const role = authorization?.role;
  return Boolean(
    authorization &&
    authorization.userId === ctx.principal.userId &&
    authorization.suspendedAt === null &&
    authorization.permissions.includes("workspace.members.manage") &&
    role?.key &&
    isWorkspaceAdmin(role.key) &&
    role.id === BUILT_IN_ROLE_REGISTRY[role.key].id
  );
}

function deploymentConfiguration(env: Env) {
  const deployment: AdmissionRules = {
    allowedGitHubUsers: parseAdmissionAllowlist(env.ALLOWED_USERS).sort(),
    allowedEmails: parseAdmissionAllowlist(env.ALLOWED_EMAILS).sort(),
    allowedEmailDomains: parseAdmissionAllowlist(env.ALLOWED_EMAIL_DOMAINS).sort(),
    allowedGitHubOrganizations: parseAdmissionAllowlist(env.ALLOWED_GITHUB_ORGS).sort(),
  };
  const enabledProviders: AdmissionPolicySnapshot["enabledProviders"] = [];
  if (env.GITHUB_CLIENT_ID?.trim() && env.GITHUB_CLIENT_SECRET?.trim())
    enabledProviders.push("github");
  if (env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim())
    enabledProviders.push("google");
  return {
    deployment,
    enabledProviders,
    unsafeAllowAllUsers: parseAdmissionBoolean(env.UNSAFE_ALLOW_ALL_USERS),
  };
}

async function deploymentHash(config: ReturnType<typeof deploymentConfiguration>): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(config))
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function snapshotResponse(
  config: ReturnType<typeof deploymentConfiguration>,
  policy: StoredAdmissionPolicy,
  hash: string
): Response {
  const effective = mergeAdmissionRules(config.deployment, policy.rules);
  for (const list of Object.values(effective)) list.sort();
  const snapshot: AdmissionPolicySnapshot = {
    ...config,
    managed: policy.rules,
    effective,
    revision: policy.revision,
    etag: `"admission-${policy.revision}-${hash}"`,
    updatedAt: policy.updatedAt,
    updatedByUserId: policy.updatedByUserId,
    unsafeAllowAllEffective:
      config.unsafeAllowAllUsers && Object.values(effective).every((list) => list.length === 0),
    editingDisabledReason: config.unsafeAllowAllUsers ? "unsafe_allow_all" : null,
  };
  const response = json(snapshot);
  response.headers.set("ETag", snapshot.etag);
  return response;
}

async function getPolicy(_request: Request, env: Env, _params: object, ctx: UserRouteContext) {
  if (!isAdministrator(ctx)) return failure("admission_policy_forbidden", 403);
  try {
    const config = deploymentConfiguration(env);
    const policy = await new AdmissionPolicyStore(ctx.db).get();
    return snapshotResponse(config, policy, await deploymentHash(config));
  } catch {
    logger.error("admission_policy.read_failed", { request_id: ctx.request_id });
    return failure("admission_policy_unavailable", 503);
  }
}

async function putPolicy(request: Request, env: Env, _params: object, ctx: UserRouteContext) {
  if (!isAdministrator(ctx)) return failure("admission_policy_forbidden", 403);
  const ifMatch = request.headers.get("If-Match");
  if (ifMatch === null) return failure("admission_policy_precondition_required", 428);
  const match = /^"admission-(0|[1-9]\d*)-([a-f0-9]{64})"$/.exec(ifMatch);
  if (!match || !Number.isSafeInteger(Number(match[1])))
    return failure("admission_policy_invalid_precondition", 400);
  let raw: unknown;
  try {
    const bytes = await readBodyCapped(request.body, ADMISSION_POLICY_MAX_BODY_BYTES);
    if (bytes === null) return failure("admission_policy_body_too_large", 413);
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return failure("admission_policy_invalid_json", 400);
  }
  const parsed = admissionRulesSchema.safeParse(raw);
  if (!parsed.success) {
    return json(
      {
        error: "Invalid admission rules",
        code: "admission_policy_invalid_rules",
        issues: parsed.error.issues,
      },
      400
    );
  }
  try {
    const config = deploymentConfiguration(env);
    const store = new AdmissionPolicyStore(ctx.db);
    const current = await store.get();
    if (config.unsafeAllowAllUsers) return failure("admission_policy_unsafe_allow_all", 409);
    const hash = await deploymentHash(config);
    if (match[2] !== hash) return failure("admission_policy_conflict", 412);

    // Managed rules must never rescue a deployment without a compatible recovery baseline.
    const baseline = new AdmissionPolicy({ ...config.deployment, unsafeAllowAllUsers: false });
    if (
      config.enabledProviders.length === 0 ||
      config.enabledProviders.some((provider) => !baseline.supportsSignInProvider(provider))
    )
      return failure("admission_policy_configuration", 409);

    const oldCount = mergeAdmissionRules(config.deployment, current.rules)
      .allowedGitHubOrganizations.length;
    const newCount = mergeAdmissionRules(config.deployment, parsed.data).allowedGitHubOrganizations
      .length;
    const baselineCount = config.deployment.allowedGitHubOrganizations.length;
    // Mismatched revisions go through audited CAS, which also fences this exact preimage.
    if (
      Number(match[1]) === current.revision &&
      newCount > Math.max(MAX_MANAGED_ADMISSION_ORGANIZATIONS, baselineCount) &&
      newCount > oldCount
    ) {
      return failure("admission_policy_organization_limit", 409);
    }
    const result = await store.replace({
      before: current,
      expectedRevision: Number(match[1]),
      rules: parsed.data,
      actorUserId: ctx.principal.userId,
      requestId: ctx.request_id,
      now: Date.now(),
      deploymentHash: hash,
    });
    logger.info("admission_policy.save", { outcome: result.status, request_id: ctx.request_id });
    switch (result.status) {
      case "actor_authorization_changed":
        return failure("admission_policy_forbidden", 403);
      case "conflict":
        return failure("admission_policy_conflict", 412);
      case "unavailable":
        return failure("admission_policy_unavailable", 503);
      default:
        return snapshotResponse(config, result.policy, hash);
    }
  } catch {
    logger.error("admission_policy.save_failed", { request_id: ctx.request_id });
    return failure("admission_policy_unavailable", 503);
  }
}

export const admissionPolicyRoutes = new Hono<ControlPlaneHonoEnv>();
const manage = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  authorization: requirePermission("workspace.members.manage", { service: "deny" }),
  cacheControl: "private, no-store",
});
admissionPolicyRoutes.get("/settings/admission-policy", manage, (c) => dispatch(c, getPolicy));
admissionPolicyRoutes.put("/settings/admission-policy", manage, (c) => dispatch(c, putPolicy));
