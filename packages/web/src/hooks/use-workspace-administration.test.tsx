// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearAuthSessionCache, useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { useWorkspaceAdministration } from "./use-workspace-administration";

vi.mock("@/lib/auth-session", () => ({
  useAuthSession: vi.fn(),
  clearAuthSessionCache: vi.fn(),
}));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));

const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);

const member = {
  userId: "11111111111111111111111111111111",
  displayName: "Ada",
  email: "ada@example.com",
  avatarUrl: null,
  suspendedAt: null,
  role: { id: "role_builtin_member", key: "member" as const, name: "Member" },
  createdAt: 1,
};

describe("useWorkspaceAdministration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "unauthenticated" });
    vi.mocked(browserApiFetch).mockResolvedValue(new Response(null, { status: 204 }));
  });

  it("sends the simplified role and suspension mutation contracts", async () => {
    const { result } = renderHook(
      () => useWorkspaceAdministration({ readMembers: false, readRoles: false }),
      { wrapper }
    );

    await act(() => result.current.updateMember(member, { kind: "role", roleId: "role_release" }));
    await act(() => result.current.updateMember(member, { kind: "status", suspended: true }));

    expect(browserApiFetch).toHaveBeenNthCalledWith(
      1,
      `/api/members/${member.userId}/role`,
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ roleId: "role_release" }) })
    );
    expect(browserApiFetch).toHaveBeenNthCalledWith(
      2,
      `/api/members/${member.userId}/status`,
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ suspended: true }) })
    );
  });

  it("treats self-suspension as successful and clears the authenticated session cache", async () => {
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: member.userId, name: "Ada", email: "ada@example.com", image: null } },
      status: "authenticated",
    });
    vi.mocked(clearAuthSessionCache).mockResolvedValue(undefined);
    const { result } = renderHook(
      () => useWorkspaceAdministration({ readMembers: false, readRoles: false }),
      { wrapper }
    );

    await expect(
      act(() => result.current.updateMember(member, { kind: "status", suspended: true }))
    ).resolves.toBeUndefined();

    expect(clearAuthSessionCache).toHaveBeenCalledTimes(1);
  });
});
