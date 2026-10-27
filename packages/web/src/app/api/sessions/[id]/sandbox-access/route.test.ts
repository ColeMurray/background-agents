import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET } from "./route";

const params = Promise.resolve({ id: "session/1" });

describe("GET /api/sessions/[id]/sandbox-access", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    ["", "/sessions/session%2F1/sandbox-access"],
    ["?connect=1", "/sessions/session%2F1/sandbox-access?connect=1"],
    ["?connect=yes", "/sessions/session%2F1/sandbox-access"],
  ])("forwards only an explicit connect (%s)", async (search, upstream) => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ codeServer: null }));
    await GET(new Request(`http://localhost/api/sessions/session%2F1/sandbox-access${search}`), {
      params,
    });
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(upstream, { cache: "no-store" });
  });

  it("passes a connect requirement through for the page to ask", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Connect first", code: "sandbox_connect_required" }, { status: 409 })
    );
    const response = await GET(new Request("http://localhost/api/sessions/s/sandbox-access"), {
      params,
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "sandbox_connect_required" });
  });
});
