// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyAdmissionRules,
  type AdmissionPolicySnapshot,
} from "@open-inspect/shared/admission-settings";
import type { EffectiveAuthorization } from "@open-inspect/shared/rbac";
import { clearAuthSessionCache, useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { useCurrentUserAuthorization } from "./use-current-user-authorization";
import { useAdmissionPolicy } from "./use-admission-policy";

const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("swr", () => ({ useSWRConfig: () => ({ mutate }) }));
vi.mock("@/lib/auth-session", () => ({ useAuthSession: vi.fn(), clearAuthSessionCache: vi.fn() }));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));
vi.mock("./use-current-user-authorization", () => ({
  useCurrentUserAuthorization: vi.fn(),
  currentUserAuthorizationKey: (id: string) => ["/api/me/authorization", id],
}));

const actor: EffectiveAuthorization = {
  userId: "11111111111111111111111111111111",
  suspendedAt: null,
  role: { id: "role_builtin_owner", key: "owner", name: "Owner" },
  permissions: ["workspace.members.manage"],
};
const initial: AdmissionPolicySnapshot = {
  deployment: { ...emptyAdmissionRules(), allowedEmails: ["recovery@example.com"] },
  managed: emptyAdmissionRules(),
  effective: { ...emptyAdmissionRules(), allowedEmails: ["recovery@example.com"] },
  revision: 0,
  etag: '"policy-0"',
  updatedAt: null,
  updatedByUserId: null,
  enabledProviders: ["github", "google"],
  unsafeAllowAllUsers: false,
  unsafeAllowAllEffective: false,
  editingDisabledReason: null,
};
const edited = { ...emptyAdmissionRules(), allowedEmails: ["new@example.com"] };
function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function authorize(authorization: EffectiveAuthorization | null = actor, permission = true) {
  vi.mocked(useCurrentUserAuthorization).mockReturnValue({
    authorization,
    loading: false,
    error: null,
    hasPermission: () => permission,
  });
}
async function loaded() {
  const hook = renderHook(useAdmissionPolicy);
  await waitFor(() => expect(hook.result.current.snapshot).not.toBeNull());
  return hook;
}

beforeEach(() => {
  vi.resetAllMocks();
  mutate.mockResolvedValue(undefined);
  vi.mocked(clearAuthSessionCache).mockResolvedValue(undefined);
  vi.mocked(useAuthSession).mockReturnValue({
    data: { user: { id: actor.userId, name: "Owner" } },
    status: "authenticated",
  });
  authorize();
  vi.mocked(browserApiFetch).mockResolvedValue(json(initial));
});
afterEach(cleanup);

describe("useAdmissionPolicy", () => {
  it.each(["custom", "member", "viewer", "missing-permission", "suspended", "other-user"])(
    "does not fetch for %s authorization",
    (scenario) => {
      authorize(
        {
          ...actor,
          ...(scenario === "other-user" ? { userId: "22222222222222222222222222222222" } : {}),
          suspendedAt: scenario === "suspended" ? 1 : null,
          role:
            scenario === "custom"
              ? { id: "role_custom", key: null, name: "Owner" }
              : scenario === "member" || scenario === "viewer"
                ? { id: `role_builtin_${scenario}`, key: scenario, name: scenario }
                : actor.role,
        },
        scenario !== "missing-permission"
      );
      const { result } = renderHook(useAdmissionPolicy);
      expect(result.current.canEdit).toBe(false);
      expect(browserApiFetch).not.toHaveBeenCalled();
    }
  );

  it.each(["owner", "administrator"] as const)("fetches for a canonical %s", async (key) => {
    authorize({ ...actor, role: { id: `role_builtin_${key}`, key, name: key } });
    const { result } = await loaded();
    expect(result.current.canEdit).toBe(true);
    expect(browserApiFetch).toHaveBeenCalledWith(
      "/api/settings/admission-policy",
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it.each([json({}, 503), json({ managed: emptyAdmissionRules() })])(
    "never turns an unavailable or malformed initial response into an editable empty policy",
    async (response) => {
      vi.mocked(browserApiFetch).mockResolvedValue(response);
      const { result } = renderHook(useAdmissionPolicy);
      await waitFor(() => expect(result.current.error).not.toBeNull());
      expect(result.current.snapshot).toBeNull();
      expect(result.current.draft).toBeNull();
      expect(result.current.canEdit).toBe(false);
      vi.mocked(browserApiFetch).mockResolvedValue(json(initial));
      await act(() => result.current.reload());
      expect(result.current.canEdit).toBe(true);
    }
  );

  it("does not allow edits during unsafe allow-all", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(
      json({ ...initial, editingDisabledReason: "unsafe_allow_all" })
    );
    const { result } = await loaded();
    expect(result.current.canEdit).toBe(false);
    act(() => result.current.setDraft(edited));
    await act(() => result.current.save());
    expect(result.current.draft).toEqual(initial.managed);
    expect(browserApiFetch).toHaveBeenCalledTimes(1);
  });

  it("normalizes saves, pins If-Match, and prevents double submission", async () => {
    const { result } = await loaded();
    act(() => result.current.setDraft({ ...edited, allowedEmails: [" NEW@example.com "] }));
    let finish!: (response: Response) => void;
    vi.mocked(browserApiFetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    let saving!: Promise<void>;
    act(() => {
      saving = result.current.save();
      void result.current.save();
    });
    expect(result.current.saving).toBe(true);
    expect(result.current.canEdit).toBe(false);
    expect(browserApiFetch).toHaveBeenCalledTimes(2);
    expect(browserApiFetch).toHaveBeenLastCalledWith("/api/settings/admission-policy", {
      cache: "no-store",
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": initial.etag },
      body: JSON.stringify(edited),
    });
    await act(async () => {
      finish(json({ ...initial, managed: edited, revision: 1, etag: '"policy-1"' }));
      await saving;
    });
    expect(result.current.changes).toEqual([]);
    expect(result.current.snapshot?.etag).toBe('"policy-1"');
    expect(result.current.notice).toContain("saved");
  });

  it("preserves conflicts without retry and requires explicit reload before review with a fresh token", async () => {
    const { result } = await loaded();
    act(() => result.current.setDraft(edited));
    vi.mocked(browserApiFetch).mockResolvedValueOnce(json({ error: "Stale" }, 412));
    await act(() => result.current.save());
    expect(result.current.needsReload).toBe(true);
    expect(result.current.draft).toEqual(edited);
    await act(() => result.current.save());
    expect(browserApiFetch).toHaveBeenCalledTimes(2);
    const fresh = {
      ...initial,
      etag: '"policy-2"',
      revision: 2,
      managed: { ...emptyAdmissionRules(), allowedEmails: ["another-admin@example.com"] },
    };
    vi.mocked(browserApiFetch).mockResolvedValueOnce(json(fresh));
    await act(() => result.current.reload());
    expect(result.current.snapshot?.etag).toBe(fresh.etag);
    expect(result.current.draft).toEqual(edited);
    expect(result.current.changes).toContainEqual({
      type: "allowedEmails",
      value: "another-admin@example.com",
      action: "Remove",
    });
    expect(result.current.notice).toContain("Review");
    expect(browserApiFetch).toHaveBeenCalledTimes(3);
    vi.mocked(browserApiFetch).mockResolvedValueOnce(json({ ...fresh, managed: edited }));
    await act(() => result.current.save());
    expect(browserApiFetch).toHaveBeenLastCalledWith(
      "/api/settings/admission-policy",
      expect.objectContaining({
        headers: { "Content-Type": "application/json", "If-Match": fresh.etag },
      })
    );
  });

  it("requires verification after a lost mutation response, preserving the draft", async () => {
    const { result } = await loaded();
    act(() => result.current.setDraft(edited));
    vi.mocked(browserApiFetch).mockRejectedValueOnce(new TypeError("Network lost"));
    await act(() => result.current.save());
    expect(result.current.error).toContain("Cannot confirm the save");
    expect(result.current.draft).toEqual(edited);
    expect(result.current.canEdit).toBe(false);
    await act(() => result.current.save());
    expect(browserApiFetch).toHaveBeenCalledTimes(2);
    vi.mocked(browserApiFetch).mockResolvedValueOnce(
      json({ ...initial, managed: edited, revision: 1, etag: '"policy-1"' })
    );
    await act(() => result.current.reload());
    expect(result.current.changes).toEqual([]);
  });

  it.each([401, 403])(
    "withdraws cached authorization on a %i save and hides policy data",
    async (status) => {
      const { result } = await loaded();
      act(() => result.current.setDraft(edited));
      vi.mocked(browserApiFetch).mockResolvedValueOnce(json({}, status));
      await act(() => result.current.save());
      expect(result.current.denied).toBe(true);
      expect(result.current.snapshot).toBeNull();
      expect(result.current.draft).toBeNull();
      expect(mutate).toHaveBeenCalledWith(["/api/me/authorization", actor.userId], undefined, {
        revalidate: false,
      });
      expect(clearAuthSessionCache).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
      await act(() => result.current.reload());
      expect(browserApiFetch).toHaveBeenCalledTimes(2);
    }
  );

  it.each([401, 403])("withdraws access on an initial %i response", async (status) => {
    vi.mocked(browserApiFetch).mockResolvedValueOnce(json({}, status));
    const { result } = renderHook(useAdmissionPolicy);
    await waitFor(() => expect(result.current.denied).toBe(true));
    expect(result.current.draft).toBeNull();
    expect(result.current.canEdit).toBe(false);
    expect(mutate).toHaveBeenCalledWith(["/api/me/authorization", actor.userId], undefined, {
      revalidate: false,
    });
    expect(clearAuthSessionCache).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  });

  it("does not expose the previous user's draft after sign-out", async () => {
    const { result, rerender } = await loaded();
    act(() => result.current.setDraft(edited));
    vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "unauthenticated" });
    rerender();
    expect(result.current.snapshot).toBeNull();
    expect(result.current.draft).toBeNull();
    expect(result.current.canEdit).toBe(false);
  });

  it("ignores an old user's in-flight read after an account change", async () => {
    let finishOldRead!: (response: Response) => void;
    vi.mocked(browserApiFetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOldRead = resolve;
        })
    );
    const { result, rerender } = renderHook(useAdmissionPolicy);
    const nextUserId = "22222222222222222222222222222222";
    authorize({ ...actor, userId: nextUserId });
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: nextUserId, name: "Next admin" } },
      status: "authenticated",
    });
    rerender();
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    await act(async () => {
      finishOldRead(json({ ...initial, managed: edited }));
    });
    expect(result.current.draft).toEqual(initial.managed);
    expect(browserApiFetch).toHaveBeenCalledTimes(2);
  });

  it("preserves the new user's snapshot and edits when an old user's save completes", async () => {
    const { result, rerender } = await loaded();
    act(() => result.current.setDraft(edited));
    let finishOldSave!: (response: Response) => void;
    vi.mocked(browserApiFetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOldSave = resolve;
        })
    );
    let saving!: Promise<void>;
    act(() => {
      saving = result.current.save();
    });
    expect(result.current.saving).toBe(true);

    const nextUserId = "22222222222222222222222222222222";
    const nextSnapshot = {
      ...initial,
      managed: { ...emptyAdmissionRules(), allowedEmails: ["next-admin@example.com"] },
      revision: 2,
      etag: '"policy-2"',
    };
    vi.mocked(browserApiFetch).mockResolvedValueOnce(json(nextSnapshot));
    authorize({ ...actor, userId: nextUserId });
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: nextUserId, name: "Next admin" } },
      status: "authenticated",
    });
    rerender();
    await waitFor(() => expect(result.current.snapshot).toEqual(nextSnapshot));
    const nextDraft = { ...nextSnapshot.managed, allowedEmailDomains: ["example.org"] };
    act(() => result.current.setDraft(nextDraft));

    await act(async () => {
      finishOldSave(json({ ...initial, managed: edited, revision: 1, etag: '"policy-1"' }));
      await saving;
    });
    expect(result.current.snapshot).toEqual(nextSnapshot);
    expect(result.current.draft).toEqual(nextDraft);
    expect(result.current.saving).toBe(false);
    expect(result.current.notice).toBeNull();
    expect(browserApiFetch).toHaveBeenCalledTimes(3);
  });

  it("keeps validation failures editable without losing unrelated draft changes", async () => {
    const { result } = await loaded();
    act(() => result.current.setDraft(edited));
    vi.mocked(browserApiFetch).mockResolvedValueOnce(
      json(
        {
          error: "Invalid organization fan-out",
          issues: [{ path: ["allowedGitHubOrganizations", 0], message: "Use a bare login" }],
        },
        400
      )
    );
    await act(() => result.current.save());
    expect(result.current.error).toContain("Invalid organization");
    expect(result.current.error).toContain("allowedGitHubOrganizations.0: Use a bare login");
    expect(result.current.draft).toEqual(edited);
    expect(result.current.canEdit).toBe(true);
  });

  it("explains organization fan-out refusals and allows correcting the preserved draft", async () => {
    const { result } = await loaded();
    act(() => result.current.setDraft(edited));
    vi.mocked(browserApiFetch).mockResolvedValueOnce(
      json(
        { error: "Admission policy request failed", code: "admission_policy_organization_limit" },
        409
      )
    );
    await act(() => result.current.save());
    expect(result.current.error).toContain("Deployment rules also count");
    expect(result.current.needsReload).toBe(false);
    expect(result.current.canEdit).toBe(true);
  });

  it("clears a rejected save error when discarding the draft", async () => {
    const { result } = await loaded();
    act(() => result.current.setDraft(edited));
    vi.mocked(browserApiFetch).mockResolvedValueOnce(json({ error: "Invalid rules" }, 400));
    await act(() => result.current.save());
    expect(result.current.error).toBe("Invalid rules");
    act(() => result.current.discard());
    expect(result.current.draft).toEqual(initial.managed);
    expect(result.current.changes).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.notice).toBeNull();
  });

  it("keeps the reload requirement after discarding an uncertain save", async () => {
    const { result } = await loaded();
    act(() => result.current.setDraft(edited));
    vi.mocked(browserApiFetch).mockRejectedValueOnce(new Error("Connection lost"));
    await act(() => result.current.save());
    act(() => result.current.discard());
    expect(result.current.error).toBeNull();
    expect(result.current.needsReload).toBe(true);
    expect(result.current.canEdit).toBe(false);
  });

  it.each(["lost-response", "conflict"])(
    "adopts server rules on reload after discarding a %s draft",
    async (failure) => {
      const { result } = await loaded();
      act(() => result.current.setDraft(edited));
      if (failure === "lost-response") {
        vi.mocked(browserApiFetch).mockRejectedValueOnce(new Error("Connection lost"));
      } else {
        vi.mocked(browserApiFetch).mockResolvedValueOnce(json({}, 412));
      }
      await act(() => result.current.save());
      act(() => result.current.discard());
      expect(result.current.changes).toEqual([]);
      expect(result.current.needsReload).toBe(true);
      const serverRules = {
        ...emptyAdmissionRules(),
        allowedEmails: [
          failure === "lost-response" ? "new@example.com" : "another-admin@example.com",
        ],
      };
      vi.mocked(browserApiFetch).mockResolvedValueOnce(
        json({ ...initial, managed: serverRules, revision: 1, etag: '"policy-1"' })
      );
      await act(() => result.current.reload());
      expect(result.current.draft).toEqual(serverRules);
      expect(result.current.changes).toEqual([]);
      expect(result.current.notice).toBeNull();
      expect(result.current.needsReload).toBe(false);
    }
  );
});
