import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApiFetch } from "./browser-api-fetch";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browserApiFetch", () => {
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
});
