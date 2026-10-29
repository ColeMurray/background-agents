"use client";

import { useEffect, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import {
  admissionPolicySnapshotSchema,
  admissionRulesSchema,
  type AdmissionPolicySnapshot,
  type AdmissionRules,
} from "@open-inspect/shared/admission-settings";
import { isWorkspaceAdmin } from "@open-inspect/shared/rbac";
import { clearAuthSessionCache, useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import {
  currentUserAuthorizationKey,
  useCurrentUserAuthorization,
} from "./use-current-user-authorization";

const POLICY_PATH = "/api/settings/admission-policy";

class PolicyRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
  }
}

async function requestPolicy(init?: RequestInit): Promise<AdmissionPolicySnapshot> {
  const response = await browserApiFetch(POLICY_PATH, { cache: "no-store", ...init });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code =
      body && typeof body === "object" && "code" in body && typeof body.code === "string"
        ? body.code
        : undefined;
    const policyMessages: Record<string, string> = {
      admission_policy_unsafe_allow_all:
        "Ask your operator to disable unsafe allow-all before you edit rules.",
      admission_policy_configuration: "Sign-in setup is incomplete. Contact your operator.",
      admission_policy_organization_limit:
        "Organization limit reached. Remove a settings rule before you add another. Deployment rules also count.",
    };
    const message =
      (code && policyMessages[code]) ||
      (body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `Allowlist request failed (${response.status})`);
    const issues =
      body && typeof body === "object" && "issues" in body && Array.isArray(body.issues)
        ? body.issues.flatMap((issue: unknown) => {
            if (
              !issue ||
              typeof issue !== "object" ||
              !("message" in issue) ||
              typeof issue.message !== "string"
            )
              return [];
            const path =
              "path" in issue && Array.isArray(issue.path)
                ? issue.path
                    .filter((part: unknown) => typeof part === "string" || typeof part === "number")
                    .join(".")
                : "";
            return [`${path ? `${path}: ` : ""}${issue.message}`];
          })
        : [];
    throw new PolicyRequestError(response.status, [message, ...issues].join(" "), code);
  }
  return admissionPolicySnapshotSchema.parse(body);
}

export function admissionRuleChanges(before: AdmissionRules, after: AdmissionRules) {
  return (Object.keys(before) as (keyof AdmissionRules)[]).flatMap((type) => [
    ...after[type]
      .filter((value) => !before[type].includes(value))
      .map((value) => ({ type, value, action: "Add" as const })),
    ...before[type]
      .filter((value) => !after[type].includes(value))
      .map((value) => ({ type, value, action: "Remove" as const })),
  ]);
}

/** A reviewed snapshot is pinned until save or explicit reload, never refreshed underneath a draft. */
export function useAdmissionPolicy() {
  const { data: session, status } = useAuthSession();
  const { authorization, hasPermission } = useCurrentUserAuthorization();
  const { mutate } = useSWRConfig();
  const userId = session?.user?.id;
  const eligible =
    status === "authenticated" &&
    !!userId &&
    authorization?.userId === userId &&
    authorization.suspendedAt === null &&
    isWorkspaceAdmin(authorization.role.key) &&
    hasPermission("workspace.members.manage");
  const scope = eligible ? userId : undefined;
  const [state, setState] = useState<{
    scope?: string;
    snapshot: AdmissionPolicySnapshot | null;
    draft: AdmissionRules | null;
    loading: boolean;
    saving: boolean;
    denied: boolean;
    needsReload: boolean;
    error: string | null;
    notice: string | null;
  }>({
    snapshot: null,
    draft: null,
    loading: true,
    saving: false,
    denied: false,
    needsReload: false,
    error: null,
    notice: null,
  });
  const generation = useRef(0);
  const busy = useRef(false);

  // Cache invalidation must not turn a denied request into an unhandled rejection.
  async function withdrawAccess(httpStatus: number, actorId: string) {
    await Promise.allSettled([
      mutate(currentUserAuthorizationKey(actorId), undefined, { revalidate: false }),
      ...(httpStatus === 401 ? [clearAuthSessionCache()] : []),
    ]);
  }

  useEffect(() => {
    const token = ++generation.current;
    busy.current = false;
    setState({
      scope,
      snapshot: null,
      draft: null,
      loading: !!scope,
      saving: false,
      denied: false,
      needsReload: false,
      error: null,
      notice: null,
    });
    if (!scope) return;
    const controller = new AbortController();
    void requestPolicy({ signal: controller.signal }).then(
      (snapshot) => {
        if (generation.current !== token) return;
        setState((current) => ({ ...current, snapshot, draft: snapshot.managed, loading: false }));
      },
      (cause: unknown) => {
        if (generation.current !== token) return;
        const denied = cause instanceof PolicyRequestError && [401, 403].includes(cause.status);
        setState((current) => ({
          ...current,
          loading: false,
          denied,
          error: denied ? "You cannot edit these rules." : "Rules are unavailable. Try again.",
        }));
        if (denied) {
          void mutate(currentUserAuthorizationKey(scope), undefined, { revalidate: false }).catch(
            () => undefined
          );
          if (cause.status === 401) void clearAuthSessionCache().catch(() => undefined);
        }
      }
    );
    return () => {
      generation.current = token + 1;
      controller.abort();
    };
  }, [scope, mutate]);

  const visible = !!scope && state.scope === scope;
  const snapshot = visible && !state.denied ? state.snapshot : null;
  const draft = visible && !state.denied ? state.draft : null;
  const changes = snapshot && draft ? admissionRuleChanges(snapshot.managed, draft) : [];
  const canEdit =
    !!snapshot &&
    !snapshot.editingDisabledReason &&
    !snapshot.unsafeAllowAllUsers &&
    !state.loading &&
    !state.saving &&
    !state.needsReload;

  async function reload() {
    if (!scope || busy.current || state.denied) return;
    busy.current = true;
    const token = generation.current;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const next = await requestPolicy();
      if (generation.current !== token) return;
      setState((current) => {
        const hasEdits =
          current.snapshot &&
          current.draft &&
          admissionRuleChanges(current.snapshot.managed, current.draft).length > 0;
        return {
          ...current,
          snapshot: next,
          draft: hasEdits ? current.draft : next.managed,
          needsReload: false,
          notice: hasEdits
            ? "Rules reloaded. Your edits remain. Review them before you save."
            : null,
        };
      });
    } catch (cause) {
      if (generation.current !== token) return;
      const denied = cause instanceof PolicyRequestError && [401, 403].includes(cause.status);
      setState((current) => ({
        ...current,
        denied,
        needsReload: true,
        error: denied ? "You cannot edit these rules." : "Cannot reload rules. Your edits remain.",
      }));
      if (denied) void withdrawAccess(cause.status, scope);
    } finally {
      if (generation.current === token) {
        busy.current = false;
        setState((current) => ({ ...current, loading: false }));
      }
    }
  }

  async function save() {
    if (!canEdit || !draft || !snapshot || !scope || busy.current || !changes.length) return;
    const parsed = admissionRulesSchema.safeParse(draft);
    if (!parsed.success) {
      setState((current) => ({
        ...current,
        error: parsed.error.issues.map((issue) => issue.message).join(" "),
      }));
      return;
    }
    busy.current = true;
    const token = generation.current;
    setState((current) => ({ ...current, saving: true, error: null, notice: null }));
    try {
      const next = await requestPolicy({
        method: "PUT",
        headers: { "Content-Type": "application/json", "If-Match": snapshot.etag },
        body: JSON.stringify(parsed.data),
      });
      if (generation.current !== token) return;
      setState((current) => ({
        ...current,
        snapshot: next,
        draft: next.managed,
        notice: "Rules saved.",
      }));
    } catch (cause) {
      if (generation.current !== token) return;
      const httpStatus = cause instanceof PolicyRequestError ? cause.status : null;
      const denied = httpStatus === 401 || httpStatus === 403;
      const uncertain = httpStatus === null || httpStatus >= 500;
      const needsReload =
        uncertain ||
        httpStatus === 412 ||
        (httpStatus === 409 &&
          cause instanceof PolicyRequestError &&
          cause.code !== "admission_policy_organization_limit") ||
        httpStatus === 428;
      const error = denied
        ? "You cannot edit these rules."
        : uncertain
          ? "Cannot confirm the save. Reload rules to check. Your edits remain."
          : httpStatus === 412
            ? "Rules changed. Reload them before you save. Your edits remain."
            : cause instanceof Error
              ? cause.message
              : "Cannot save rules.";
      setState((current) => ({ ...current, denied, needsReload, error }));
      if (denied) void withdrawAccess(httpStatus, scope);
    } finally {
      if (generation.current === token) {
        busy.current = false;
        setState((current) => ({ ...current, saving: false }));
      }
    }
  }

  return {
    snapshot,
    draft,
    changes,
    canEdit,
    loading: eligible && (!visible || state.loading),
    saving: visible && state.saving,
    denied: !eligible || (visible && state.denied),
    needsReload: visible && state.needsReload,
    error: visible ? state.error : null,
    notice: visible ? state.notice : null,
    reload,
    save,
    setDraft(next: AdmissionRules) {
      if (canEdit && !busy.current)
        setState((current) => ({ ...current, draft: next, error: null, notice: null }));
    },
    discard() {
      if (snapshot && !busy.current)
        setState((current) => ({ ...current, draft: snapshot.managed, notice: null, error: null }));
    },
  };
}
