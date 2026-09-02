import { beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import {
  ACTOR_HEADER,
  SERVICE_HEADER,
  SERVICE_SIGNATURE_HEADER,
} from "@open-inspect/shared/service-auth";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

function expectCommonResponseHeaders(response: Response): void {
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f]{8}$/);
  expect(response.headers.get("x-trace-id")).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
}

async function expectJsonNotFound(response: Response, message = "Not found"): Promise<void> {
  expect(response.status).toBe(404);
  expect(response.headers.get("Content-Type")).toBe("application/json");
  expectCommonResponseHeaders(response);
  await expect(response.json()).resolves.toEqual({ error: message });
}

describe("Worker routing compatibility", () => {
  beforeEach(cleanD1Tables);

  it("treats HEAD as an unsupported method instead of implicitly dispatching GET", async () => {
    const response = await SELF.fetch("https://test.local/health", { method: "HEAD" });

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expectCommonResponseHeaders(response);
    // HTTP runtimes strip response bodies from HEAD requests even though the
    // selected legacy response is the JSON Not found response.
    await expect(response.text()).resolves.toBe("");
  });

  it("matches static paths against their raw encoded form", async () => {
    await expectJsonNotFound(await SELF.fetch("https://test.local/he%61lth"));
  });

  it.each([
    ["GET", "/definitely-unknown"],
    ["PUT", "/health"],
  ])("rejects unmatched %s %s before inspecting credentials", async (method, path) => {
    const response = await SELF.fetch(`https://test.local${path}`, {
      method,
      headers: {
        [SERVICE_HEADER]: "slack-bot",
        [SERVICE_SIGNATURE_HEADER]: "sig1.not-a-timestamp.nonce.signature",
        [ACTOR_HEADER]: "slack:unmatched-route",
      },
    });

    await expectJsonNotFound(response);
    const users = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{
      count: number;
    }>();
    expect(users?.count).toBe(0);
  });

  it("prefers the literal inbox route but treats its encoded alias as a dynamic session id", async () => {
    const literalResponse = await serviceFetch("https://test.local/sessions/inbox");
    expect(literalResponse.status).toBe(200);
    expect(await literalResponse.json()).toMatchObject({
      categories: {
        finished: { items: [] },
        in_progress: { items: [] },
        needs_attention: { items: [] },
      },
    });

    const encodedResponse = await serviceFetch("https://test.local/sessions/%69nbox");
    await expectJsonNotFound(encodedResponse, "Session not found");
  });

  it.each(["/health/", "//health", "/Health"])(
    "does not normalize the strict path %s",
    async (path) => {
      await expectJsonNotFound(await SELF.fetch(`https://test.local${path}`));
    }
  );

  it("passes a malformed percent escape through raw dynamic matching", async () => {
    const response = await serviceFetch("https://test.local/sessions/%E0%A4%A");

    await expectJsonNotFound(response, "Session not found");
  });

  it("returns the universal preflight response for an unknown path", async () => {
    const response = await SELF.fetch("https://test.local/definitely-unknown", {
      method: "OPTIONS",
      headers: { "x-trace-id": "routing-compatibility-trace" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBeNull();
    expect(Object.fromEntries(response.headers.entries())).toEqual({
      "access-control-allow-headers": "Content-Type, Authorization",
      "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "access-control-allow-origin": "*",
      "access-control-max-age": "86400",
      "x-request-id": expect.stringMatching(/^[0-9a-f]{8}$/),
      "x-trace-id": "routing-compatibility-trace",
    });
    await expect(response.text()).resolves.toBe("");
  });
});
