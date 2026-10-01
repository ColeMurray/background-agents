import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { PUT } from "./route";

vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } });
  vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ environment: {} }));
});

it("omits ownership and unknown fields from configuration updates", async () => {
  await PUT(
    new NextRequest("http://localhost/api/environments/env-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Stack",
        teamId: "team-2",
        ownerTeamId: "team-2",
        userId: "injected",
      }),
    }),
    { params: Promise.resolve({ id: "env-1" }) }
  );
  expect(controlPlaneUserFetch).toHaveBeenCalledWith("/environments/env-1", {
    method: "PUT",
    body: JSON.stringify({ name: "Stack" }),
  });
});
