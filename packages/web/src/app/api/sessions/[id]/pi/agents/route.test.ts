import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET } from "./route";

describe("Pi agents BFF", () => {
  beforeEach(() => vi.resetAllMocks());

  it("adds a server-generated read receipt and preserves private caching", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({
        state: "completed",
        result: {
          agents: [
            {
              conversationId: 1,
              status: "idle",
              queued: 0,
              tasks: [],
              usage: {
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                costUsd: 0,
              },
              lastEntryId: null,
              hiddenPrompt: "do not expose",
              lastMessage: { text: "internal transcript" },
            },
          ],
        },
      })
    );
    const response = await GET(
      new Request("http://local/api/sessions/session-1/pi/agents") as never,
      {
        params: Promise.resolve({ id: "session-1" }),
      }
    );
    const path = vi.mocked(controlPlaneUserFetch).mock.calls[0]?.[0];
    expect(path).toMatch(/^\/sessions\/session-1\/pi\/agents\?requestId=[0-9a-f-]+$/);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("hiddenPrompt");
    expect(body).not.toContain("internal transcript");
  });
});
