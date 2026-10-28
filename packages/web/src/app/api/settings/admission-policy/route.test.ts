import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  ADMISSION_POLICY_MAX_BODY_BYTES,
  emptyAdmissionRules,
} from "@open-inspect/shared/admission-settings";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET, PUT } from "./route";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

const context = { params: Promise.resolve(undefined) };
const cookie = "__Secure-openinspect.session_token=session.signature";

beforeEach(() => vi.resetAllMocks());

describe("admission policy proxy", () => {
  it.each([undefined, "none", "null", "cross-site", "same-site", "Same-Origin"])(
    "rejects PUT with %s Fetch Metadata even with matching spoofed hosts and Origin",
    async (site) => {
      const request = new NextRequest("https://app.example/api/settings/admission-policy", {
        method: "PUT",
        headers: {
          Cookie: cookie,
          Host: "attacker.example",
          "X-Forwarded-Host": "attacker.example",
          Origin: "https://attacker.example",
          ...(site ? { "Sec-Fetch-Site": site } : {}),
        },
        body: "{}",
      });
      const response = await PUT(request, context);
      expect(response.status).toBe(403);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(request.bodyUsed).toBe(false);
      expect(controlPlaneUserFetch).not.toHaveBeenCalled();
    }
  );

  it("does not restrict GET metadata and preserves the response ETag", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ revision: 3 }, { headers: { ETag: '"policy-3"' } })
    );
    const response = await GET(
      new NextRequest("https://app.example/api/settings/admission-policy"),
      context
    );
    expect(controlPlaneUserFetch).toHaveBeenCalledExactlyOnceWith(
      "/settings/admission-policy",
      undefined
    );
    expect(response.headers.get("ETag")).toBe('"policy-3"');
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("forwards the direct four-array document and opaque If-Match token", async () => {
    const body = JSON.stringify(emptyAdmissionRules());
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ revision: 4 }, { headers: { ETag: '"policy-4"' } })
    );
    const response = await PUT(
      new NextRequest("https://app.example/api/settings/admission-policy", {
        method: "PUT",
        headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin", "If-Match": '"policy-3"' },
        body,
      }),
      context
    );
    expect(controlPlaneUserFetch).toHaveBeenCalledExactlyOnceWith("/settings/admission-policy", {
      method: "PUT",
      body,
      headers: { "If-Match": '"policy-3"' },
    });
    expect(response.headers.get("ETag")).toBe('"policy-4"');
  });

  it.each([401, 403, 409, 412, 428, 503])("preserves backend refusal status %i", async (status) => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Refused", code: "policy_refused" }, { status })
    );
    const response = await PUT(
      new NextRequest("https://app.example/api/settings/admission-policy", {
        method: "PUT",
        headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
        body: "{}",
      }),
      context
    );
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: "Refused", code: "policy_refused" });
  });

  it("requires a browser session before reading a same-origin PUT", async () => {
    const request = new NextRequest("https://app.example/api/settings/admission-policy", {
      method: "PUT",
      headers: { "Sec-Fetch-Site": "same-origin" },
      body: "{}",
    });
    expect((await PUT(request, context)).status).toBe(401);
    expect(request.bodyUsed).toBe(false);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "rejects an oversized body (Content-Length supplied: %s)",
    async (withLength) => {
      const request = new NextRequest("https://app.example/api/settings/admission-policy", {
        method: "PUT",
        headers: {
          Cookie: cookie,
          "Sec-Fetch-Site": "same-origin",
          ...(withLength ? { "Content-Length": String(ADMISSION_POLICY_MAX_BODY_BYTES + 1) } : {}),
        },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(ADMISSION_POLICY_MAX_BODY_BYTES + 1));
            controller.close();
          },
        }),
        duplex: "half",
      } as never);
      expect((await PUT(request, context)).status).toBe(413);
      expect(controlPlaneUserFetch).not.toHaveBeenCalled();
      if (withLength) expect(request.bodyUsed).toBe(false);
    }
  );

  it("allows a body exactly at the resource limit", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ ok: true }));
    const response = await PUT(
      new NextRequest("https://app.example/api/settings/admission-policy", {
        method: "PUT",
        headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
        body: " ".repeat(ADMISSION_POLICY_MAX_BODY_BYTES),
      }),
      context
    );
    expect(response.status).toBe(200);
    expect(vi.mocked(controlPlaneUserFetch).mock.calls[0][1]?.body).toHaveLength(
      ADMISSION_POLICY_MAX_BODY_BYTES
    );
  });
});
