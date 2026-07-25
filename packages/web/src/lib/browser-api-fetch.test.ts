import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { browserApiFetch, toBrowserApiPath, type BrowserApiPath } from "./browser-api-fetch";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browserApiFetch", () => {
  it("accepts only same-origin BFF paths at the type boundary", () => {
    expectTypeOf(browserApiFetch).parameter(0).toEqualTypeOf<BrowserApiPath>();
  });

  it("delegates the request and initializer to the browser fetch boundary", async () => {
    const response = new Response(null, { status: 204 });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New title" }),
    };

    await expect(browserApiFetch("/api/sessions/session-1/title", init)).resolves.toBe(response);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/title", init);
  });

  it("preserves an omitted request initializer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await browserApiFetch("/api/repos");

    expect(fetchMock.mock.calls[0]).toEqual(["/api/repos"]);
  });

  it("rejects a non-BFF target even if the compile-time contract is bypassed", () => {
    expect(() => browserApiFetch("https://example.com/api/sessions" as BrowserApiPath)).toThrow(
      "Browser API requests must use a same-origin /api/ path"
    );
  });
});

describe("toBrowserApiPath", () => {
  it("narrows a validated dynamic BFF path", () => {
    const path = toBrowserApiPath(`/api/sessions/${crypto.randomUUID()}`);

    expectTypeOf(path).toEqualTypeOf<BrowserApiPath>();
    expect(path).toMatch(/^\/api\/sessions\//);
  });

  it("rejects a dynamic path outside the BFF API", () => {
    expect(() => toBrowserApiPath("/settings")).toThrow(
      "Browser API requests must use a same-origin /api/ path"
    );
  });

  it.each(["/api/../settings", String.raw`/api/..\settings`])(
    "rejects a path that normalizes outside the BFF API: %s",
    (path) => {
      expect(() => toBrowserApiPath(path)).toThrow(
        "Browser API requests must use a same-origin /api/ path"
      );
    }
  );
});
