import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { integrationSettingsProxy } from "./integration-settings-proxy";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

describe("integrationSettingsProxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ settings: {} }));
  });

  it("forwards PATCH requests and their JSON body", async () => {
    const handlers = integrationSettingsProxy<{ id: string }>(
      ({ id }) => `/integration-settings/${id}`,
      "integration settings"
    );
    const body = { defaults: { sessionInstructions: "Run tests." } };
    const request = new Request("https://test.local/api/integration-settings/slack", {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }) as NextRequest;

    const response = await handlers.PATCH(request, { params: Promise.resolve({ id: "slack" }) });

    expect(response.status).toBe(200);
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/integration-settings/slack", {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  });
});
