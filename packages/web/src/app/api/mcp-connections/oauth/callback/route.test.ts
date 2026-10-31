import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";
const fetcher = vi.hoisted(() => vi.fn());
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: fetcher }));
afterEach(() => vi.resetAllMocks());
it("redeems only through browser-auth forwarding and removes callback secrets from navigation", async () => {
  fetcher.mockResolvedValue(new Response("{}"));
  const response = await GET(
    new NextRequest(
      "https://app.example/api/mcp-connections/oauth/callback?code=private-code&state=private-state&iss=https%3A%2F%2Fissuer.example&returnTo=https%3A%2F%2Fevil.example"
    )
  );
  expect(fetcher).toHaveBeenCalledWith("/mcp-connections/oauth/callback", {
    method: "POST",
    body: JSON.stringify({
      code: "private-code",
      state: "private-state",
      iss: "https://issuer.example",
    }),
  });
  expect(response.headers.get("location")).toBe(
    "https://app.example/settings?tab=mcp-connections&mcp=connected"
  );
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("cache-control")).toBe("no-store");
});
it("provider denial remains sanitized and never redeems a missing code", async () => {
  const response = await GET(
    new NextRequest(
      "https://app.example/api/mcp-connections/oauth/callback?error=access_denied&error_description=private-details"
    )
  );
  expect(fetcher).not.toHaveBeenCalled();
  expect(response.headers.get("location")).toBe(
    "https://app.example/settings?tab=mcp-connections&mcp=reconnect_required"
  );
});
