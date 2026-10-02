import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { browserApiFetch } from "./browser-api-fetch";
import { archiveSession } from "./archive-session";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("./browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));
afterEach(() => vi.clearAllMocks());

describe("archiveSession", () => {
  it("shows the server reason_code on a 403 without reporting success", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({ error: "Forbidden", reason_code: "team_inactive" }, { status: 403 })
    );
    expect(await archiveSession("session-1")).toBe(false);
    expect(toast.error).toHaveBeenCalledWith("Failed to archive session (team_inactive)");
  });
  it.each([new Response("not json", { status: 403 }), new Response(null, { status: 500 })])(
    "retains the fallback for malformed or non-denial responses",
    async (response) => {
      vi.mocked(browserApiFetch).mockResolvedValue(response);
      expect(await archiveSession("session-1")).toBe(false);
      expect(toast.error).toHaveBeenCalledWith("Failed to archive session");
    }
  );
});
