import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("./auth", () => ({
  authOptions: { providers: [] },
}));

import { getServerSession } from "next-auth";
import { authOptions } from "./auth";
import { getServerAuthSession, type ServerAuthSession } from "./server-auth-session";

describe("getServerAuthSession", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("delegates to the current NextAuth server session implementation", async () => {
    const session = { user: { id: "user-1" } };
    vi.mocked(getServerSession).mockResolvedValue(session as never);

    await expect(getServerAuthSession()).resolves.toBe(session);
    expect(getServerSession).toHaveBeenCalledOnce();
    expect(getServerSession).toHaveBeenCalledWith(authOptions);
  });

  it("exposes an app-owned session contract", () => {
    expectTypeOf(getServerAuthSession).returns.toEqualTypeOf<Promise<ServerAuthSession | null>>();
  });
});
