import { beforeEach, describe, expect, it, vi } from "vitest";
import { browserApiFetch } from "./browser-api-fetch";
import { retireWarmDraftSession } from "./warm-session";

vi.mock("./browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));

describe("warm draft cleanup", () => {
  beforeEach(() => vi.resetAllMocks());

  it("retires a superseded completed draft through the archive route", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(new Response(null, { status: 204 }));
    await retireWarmDraftSession("session-1");
    expect(browserApiFetch).toHaveBeenCalledWith("/api/sessions/session-1/archive", {
      method: "POST",
    });
  });
});
