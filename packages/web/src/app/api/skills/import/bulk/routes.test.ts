import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { POST as preview } from "./preview/route";
import { POST as confirm } from "./route";
import { BULK_SKILL_IMPORT_TIMEOUT_MS } from "./request-timeout";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

describe("bulk skill import BFF routes", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    ["/skills/import/bulk/preview", preview, 200],
    ["/skills/import/bulk", confirm, 201],
  ] as const)(
    "forwards %s with its collection timeout and unchanged body",
    async (path, handler, status) => {
      const body = JSON.stringify({
        source: { repository: { repoOwner: "group/subgroup", repoName: "skills" } },
        expectedCommitSha: "a".repeat(40),
        skills: [],
      });
      vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ skills: [] }, { status }));
      const response = await handler(
        new NextRequest(`http://localhost/api${path}`, {
          method: "POST",
          headers: { Cookie: "__Secure-openinspect.session_token=session.signature" },
          body,
        }),
        { params: Promise.resolve(undefined) }
      );
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(controlPlaneUserFetch).toHaveBeenCalledWith(
        path,
        { method: "POST", body },
        { timeoutMs: BULK_SKILL_IMPORT_TIMEOUT_MS }
      );
    }
  );
});
