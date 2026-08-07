import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getServerAuthSession: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("@/lib/server-auth-session", () => ({
  getServerAuthSession: mocks.getServerAuthSession,
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/auth-session", () => ({
  AuthSessionHydration: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/app-auth-boundary", () => ({
  AppAuthBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/sidebar-layout", () => ({
  SidebarLayout: ({ children }: { children: React.ReactNode }) => children,
}));

import AppLayout from "./layout";
import { AuthSessionHydration } from "@/lib/auth-session";

describe("protected app layout", () => {
  beforeEach(() => vi.resetAllMocks());

  it("hydrates the client auth cache from the authenticated server session", async () => {
    const session = {
      user: { id: "user-1", name: "Ada", email: "ada@example.com", image: null },
    };
    mocks.getServerAuthSession.mockResolvedValue(session);

    const result = await AppLayout({ children: <div>protected</div> });

    expect(result.type).toBe(AuthSessionHydration);
    expect(result.props.session).toBe(session);
  });

  it("redirects unauthenticated requests before rendering protected content", async () => {
    mocks.getServerAuthSession.mockResolvedValue(null);
    await expect(AppLayout({ children: <div>protected</div> })).rejects.toThrow("redirect:/login");
    expect(mocks.redirect).toHaveBeenCalledWith("/login");
  });
});
