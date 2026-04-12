import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("@/lib/control-plane", () => ({
  controlPlaneFetch: vi.fn(),
}));

import { getServerSession } from "next-auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import { GET } from "./route";

describe("session media API route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects invalid artifact IDs before proxying to the control plane", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1" },
    } as never);

    const response = await GET(new Request("http://localhost/api/sessions/session-1/media/bad"), {
      params: Promise.resolve({
        id: "session-1",
        artifactId: "../../admin",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid artifact ID" });
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });
});
