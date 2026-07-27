import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { browserApiFetch, type BrowserApiPath } from "./browser-api-fetch";

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
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/title", {
      ...init,
      mode: "same-origin",
      credentials: "same-origin",
    });
  });

  it("enforces same-origin browser behavior when the request initializer is omitted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await browserApiFetch("/api/repos");

    expect(fetchMock).toHaveBeenCalledWith("/api/repos", {
      mode: "same-origin",
      credentials: "same-origin",
    });
  });
});
