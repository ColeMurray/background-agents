import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex, verifyServiceSignature } from "@open-inspect/shared/service-auth";
import { extractAgentResponse } from "./extractor";
import { createFakeKV, makeLinearBotEnv } from "../test-helpers";

describe("extractAgentResponse", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("signs the external Linear team on every events page and the artifacts read", async () => {
    const requests: { url: URL; headers: Headers }[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ url, headers: new Headers(init?.headers) });
      if (url.pathname.endsWith("/events")) {
        const lastPage = url.searchParams.has("cursor");
        return Response.json({
          events: [
            {
              id: lastPage ? "token-2" : "token-1",
              type: "token",
              data: { content: lastPage ? "Final response" : "Partial response" },
              messageId: "message-1",
              createdAt: lastPage ? 20 : 10,
            },
          ],
          hasMore: !lastPage,
          ...(lastPage ? {} : { cursor: "cursor-1" }),
        });
      }
      return Response.json({
        artifacts: [
          {
            id: "pr-1",
            type: "pr",
            url: "https://github.com/acme/backend/pull/1",
            metadata: { number: 1 },
            createdAt: 15,
          },
        ],
      });
    });
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv, { CONTROL_PLANE: { fetch } });

    const response = await extractAgentResponse(
      env,
      "session-1",
      "message-1",
      "external-team-1",
      "trace-1"
    );

    expect(response.textContent).toBe("Final response");
    expect(response.artifacts).toEqual([
      {
        type: "pr",
        url: "https://github.com/acme/backend/pull/1",
        label: "PR #1",
        metadata: { number: 1 },
      },
    ]);
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      "/sessions/session-1/events",
      "/sessions/session-1/events",
      "/sessions/session-1/artifacts",
    ]);
    expect(requests[0].url.searchParams.get("message_id")).toBe("message-1");
    expect(requests[0].url.searchParams.get("limit")).toBe("200");
    expect(requests[1].url.searchParams.get("cursor")).toBe("cursor-1");
    for (const { url, headers } of requests) {
      expect(url.searchParams.get("channel")).toBe("linear:external-team-1");
      expect(url.searchParams.has("purpose")).toBe(false);
      expect(headers.get("X-OpenInspect-Service")).toBe("linear-bot");
      expect(headers.get("x-trace-id")).toBe("trace-1");
      const verification = {
        signatureHeader: headers.get("X-OpenInspect-Service-Signature")!,
        service: "linear-bot" as const,
        secret: env.SERVICE_AUTH_SECRET!,
        method: "GET",
        url: url.toString(),
        bodySha256Hex: await sha256Hex(""),
        actor: "",
      };
      expect(await verifyServiceSignature(verification)).toMatchObject({ ok: true });
      const tampered = new URL(url);
      tampered.searchParams.delete("channel");
      expect(
        await verifyServiceSignature({ ...verification, url: tampered.toString() })
      ).toMatchObject({ ok: false, reason: "mismatch" });
    }
  });
});
