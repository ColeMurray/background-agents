// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { useCurrentUserAuthorization } from "./use-current-user-authorization";

vi.mock("@/lib/auth-session", () => ({ useAuthSession: vi.fn() }));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));

const authorizations = {
  owner: {
    userId: "11111111111111111111111111111111",
    suspendedAt: null,
    role: { id: "role_builtin_owner", key: "owner" as const, name: "Owner" },
    permissions: ["workspace.transfer_ownership" as const],
  },
  member: {
    userId: "22222222222222222222222222222222",
    suspendedAt: null,
    role: { id: "role_builtin_member", key: "member" as const, name: "Member" },
    permissions: ["repositories.read" as const],
  },
};

describe("useCurrentUserAuthorization", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not reuse cached authorization after the authenticated user changes", async () => {
    let currentUser: keyof typeof authorizations = "owner";
    vi.mocked(useAuthSession).mockImplementation(
      () =>
        ({
          status: "authenticated",
          data: { user: { id: authorizations[currentUser].userId } },
        }) as ReturnType<typeof useAuthSession>
    );
    vi.mocked(browserApiFetch).mockImplementation(async () =>
      Response.json(authorizations[currentUser])
    );
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
    );
    const { result, rerender } = renderHook(useCurrentUserAuthorization, { wrapper });
    await waitFor(() => expect(result.current.authorization?.role.key).toBe("owner"));
    const ownerHasPermission = result.current.hasPermission;
    rerender();
    expect(result.current.hasPermission).toBe(ownerHasPermission);

    currentUser = "member";
    rerender();

    await waitFor(() => expect(result.current.authorization?.role.key).toBe("member"));
    expect(result.current.hasPermission).not.toBe(ownerHasPermission);
    expect(result.current.hasPermission("workspace.transfer_ownership")).toBe(false);
  });
});
