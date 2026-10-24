import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { POST } from "./route";

describe("session execution cancellation BFF", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
  });

  it("proxies exact command cancellation without accepting authority in the body", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ accepted: true, state: "cancelling" })
    );
    await POST(new Request("http://local", { method: "POST", body: "ignored" }), {
      params: Promise.resolve({ id: "session-1", commandId: "cmd-1" }),
    });
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/sessions/session-1/executions/cmd-1/cancel",
      { method: "POST" }
    );
  });
});
