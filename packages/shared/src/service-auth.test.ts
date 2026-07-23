import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { computeHmacHex, verifyCallbackFromControlPlane } from "./auth";
import {
  ACTOR_HEADER,
  buildCanonicalRequestString,
  buildOutboundAuthHeaders,
  buildServiceAuthHeaders,
  canonicalizeQuery,
  isServiceName,
  resolveOutboundCredential,
  SERVICE_HEADER,
  SERVICE_SIGNATURE_HEADER,
  sha256Hex,
  verifyServiceSignature,
  type ServiceName,
} from "./service-auth";

interface Vector {
  name: string;
  service: ServiceName;
  secret: string;
  timestampMs: number;
  nonce: string;
  method: string;
  url: string;
  body?: string;
  bodyBase64?: string;
  actor?: string;
  expected: {
    pathname: string;
    canonicalQuery: string;
    bodySha256Hex: string;
    canonicalString: string;
    signatureHex: string;
    signatureHeader: string;
  };
}

const fixturePath = path.resolve(import.meta.dirname, "../test-fixtures/service-auth-vectors.json");
const { vectors, malformedHeaders } = JSON.parse(readFileSync(fixturePath, "utf-8")) as {
  vectors: Vector[];
  malformedHeaders: { name: string; signatureHeader: string; reason: string }[];
};

function vectorBody(vector: Vector): Uint8Array | string {
  if (vector.bodyBase64) {
    return Uint8Array.from(Buffer.from(vector.bodyBase64, "base64"));
  }
  return vector.body ?? "";
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("golden vectors (cross-language contract with service_auth.py)", () => {
  it.each(vectors.map((v) => [v.name, v] as const))("%s", async (_name, vector) => {
    const url = new URL(vector.url);
    expect(url.pathname).toBe(vector.expected.pathname);
    expect(canonicalizeQuery(url.search)).toBe(vector.expected.canonicalQuery);

    const bodySha256Hex = await sha256Hex(vectorBody(vector));
    expect(bodySha256Hex).toBe(vector.expected.bodySha256Hex);

    const canonical = buildCanonicalRequestString({
      service: vector.service,
      timestampMs: vector.timestampMs,
      nonce: vector.nonce,
      method: vector.method,
      pathname: url.pathname,
      canonicalQuery: canonicalizeQuery(url.search),
      bodySha256Hex,
      actor: vector.actor ?? "",
    });
    expect(canonical).toBe(vector.expected.canonicalString);
    expect(await computeHmacHex(canonical, vector.secret)).toBe(vector.expected.signatureHex);
  });

  it("verifies every vector's signature header inside the validity window", async () => {
    for (const vector of vectors) {
      vi.spyOn(Date, "now").mockReturnValue(vector.timestampMs);
      const result = await verifyServiceSignature({
        signatureHeader: vector.expected.signatureHeader,
        service: vector.service,
        secret: vector.secret,
        method: vector.method,
        url: vector.url,
        bodySha256Hex: vector.expected.bodySha256Hex,
        actor: vector.actor ?? "",
      });
      expect(result, vector.name).toEqual({
        ok: true,
        timestampMs: vector.timestampMs,
        nonce: vector.nonce,
      });
    }
  });

  it("rejects every malformed header in the fixture with the pinned reason", async () => {
    for (const { name, signatureHeader, reason } of malformedHeaders) {
      const result = await verifyServiceSignature({
        signatureHeader,
        service: "web",
        secret: "s",
        method: "GET",
        url: "https://cp.example.com/",
        bodySha256Hex: await sha256Hex(""),
        actor: "",
      });
      expect(result, name).toEqual({ ok: false, reason });
    }
  });

  it("canonicalizes reordered query strings identically", () => {
    const ordered = vectors.find((v) => v.name.includes("b before a"));
    const reordered = vectors.find((v) => v.name.includes("reordered"));
    expect(ordered && reordered).toBeTruthy();
    expect(ordered!.expected.canonicalString).toBe(reordered!.expected.canonicalString);
    expect(ordered!.expected.signatureHex).toBe(reordered!.expected.signatureHex);
  });

  it("encodes raw and pre-encoded unicode paths identically", () => {
    const [raw, encoded] = vectors.filter((v) => v.name.startsWith("unicode path"));
    expect(raw.expected.canonicalString).toBe(encoded.expected.canonicalString);
  });
});

describe("buildServiceAuthHeaders", () => {
  const base = {
    service: "slack-bot" as const,
    secret: "test-secret",
    method: "POST",
    url: "https://cp.example.com/sessions?b=2&a=1",
    body: '{"prompt":"hello"}',
  };

  it("round-trips through verifyServiceSignature", async () => {
    const headers = await buildServiceAuthHeaders({ ...base, actor: "slack:U1" });
    expect(headers[SERVICE_HEADER]).toBe("slack-bot");
    expect(headers[ACTOR_HEADER]).toBe("slack:U1");
    expect(headers[SERVICE_SIGNATURE_HEADER]).toMatch(/^sig1\.\d+\.[0-9a-f]{16}\.[0-9a-f]{64}$/);

    const result = await verifyServiceSignature({
      signatureHeader: headers[SERVICE_SIGNATURE_HEADER],
      service: "slack-bot",
      secret: base.secret,
      method: base.method,
      url: base.url,
      bodySha256Hex: await sha256Hex(base.body),
      actor: "slack:U1",
    });
    expect(result).toMatchObject({ ok: true });
  });

  it("omits the actor header when no actor is asserted", async () => {
    const headers = await buildServiceAuthHeaders(base);
    expect(headers[ACTOR_HEADER]).toBeUndefined();
  });

  it("carries the trace id in the x-trace-id header", async () => {
    const headers = await buildServiceAuthHeaders({ ...base, traceId: "trace-1" });
    expect(headers["x-trace-id"]).toBe("trace-1");
  });

  it("signs a bodyless request as the empty-body hash", async () => {
    const headers = await buildServiceAuthHeaders({
      service: "web",
      secret: base.secret,
      method: "GET",
      url: "https://cp.example.com/sessions",
    });
    const result = await verifyServiceSignature({
      signatureHeader: headers[SERVICE_SIGNATURE_HEADER],
      service: "web",
      secret: base.secret,
      method: "GET",
      url: "https://cp.example.com/sessions",
      bodySha256Hex: await sha256Hex(""),
      actor: "",
    });
    expect(result).toMatchObject({ ok: true });
  });
});

describe("verifyServiceSignature failures", () => {
  const vector = vectors[1]; // slack-bot POST with actor

  function verify(overrides: Partial<Parameters<typeof verifyServiceSignature>[0]>) {
    return verifyServiceSignature({
      signatureHeader: vector.expected.signatureHeader,
      service: vector.service,
      secret: vector.secret,
      method: vector.method,
      url: vector.url,
      bodySha256Hex: vector.expected.bodySha256Hex,
      actor: vector.actor ?? "",
      ...overrides,
    });
  }

  it("rejects timestamps outside the validity window", async () => {
    vi.spyOn(Date, "now").mockReturnValue(vector.timestampMs + 6 * 60 * 1000);
    expect(await verify({})).toEqual({ ok: false, reason: "expired" });
    vi.spyOn(Date, "now").mockReturnValue(vector.timestampMs - 6 * 60 * 1000);
    expect(await verify({})).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects any tampered signed component as a mismatch", async () => {
    vi.spyOn(Date, "now").mockReturnValue(vector.timestampMs);
    const cases: Partial<Parameters<typeof verifyServiceSignature>[0]>[] = [
      { secret: "wrong-secret" },
      { service: "github-bot" },
      { method: "PUT" },
      { url: vector.url.replace("/sessions", "/sessions/other") },
      { url: `${vector.url}?extra=1` },
      { bodySha256Hex: await sha256Hex("tampered body") },
      { actor: "slack:UEVIL" },
      { actor: "" },
    ];
    for (const overrides of cases) {
      expect(await verify(overrides), JSON.stringify(overrides)).toEqual({
        ok: false,
        reason: "mismatch",
      });
    }
  });
});

describe("outbound service credential", () => {
  const request = {
    method: "POST",
    url: "https://cp.example.com/sessions",
    body: '{"prompt":"hi"}',
    actor: "slack:U1",
    traceId: "trace-1",
  };

  it("resolves the per-service sig1 credential", async () => {
    const credential = resolveOutboundCredential("slack-bot", {
      SERVICE_AUTH_SECRET: "svc-secret",
    });
    expect(credential).toEqual({ service: "slack-bot", secret: "svc-secret" });

    const headers = await buildOutboundAuthHeaders(credential, request);
    expect(headers[SERVICE_HEADER]).toBe("slack-bot");
    expect(headers[ACTOR_HEADER]).toBe("slack:U1");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["x-trace-id"]).toBe("trace-1");
    const result = await verifyServiceSignature({
      signatureHeader: headers[SERVICE_SIGNATURE_HEADER],
      service: "slack-bot",
      secret: "svc-secret",
      method: request.method,
      url: request.url,
      bodySha256Hex: await sha256Hex(request.body),
      actor: request.actor,
    });
    expect(result).toMatchObject({ ok: true });
  });

  it("throws when SERVICE_AUTH_SECRET is not bound", () => {
    expect(() => resolveOutboundCredential("slack-bot", {})).toThrow(
      /SERVICE_AUTH_SECRET is required for outbound slack-bot requests/
    );
  });

  it("omits Content-Type on bodyless requests", async () => {
    const credential = resolveOutboundCredential("web", { SERVICE_AUTH_SECRET: "s" });
    const headers = await buildOutboundAuthHeaders(credential, {
      method: "GET",
      url: "https://cp.example.com/sessions",
    });
    expect(headers["Content-Type"]).toBeUndefined();
  });
});

describe("verifyCallbackFromControlPlane", () => {
  async function signedPayload(secret: string): Promise<{ ok: boolean; signature: string }> {
    const data = { ok: true };
    return { ...data, signature: await computeHmacHex(JSON.stringify(data), secret) };
  }

  it("accepts the bot's own per-service secret", async () => {
    const payload = await signedPayload("bot-secret");
    expect(
      await verifyCallbackFromControlPlane(payload, { SERVICE_AUTH_SECRET: "bot-secret" })
    ).toBe(true);
  });

  it("no longer accepts the retired shared secret", async () => {
    const payload = await signedPayload("shared-secret");
    expect(
      await verifyCallbackFromControlPlane(payload, { SERVICE_AUTH_SECRET: "bot-secret" })
    ).toBe(false);
  });

  it("rejects wrongly-signed payloads and unsigned env", async () => {
    const payload = await signedPayload("wrong-secret");
    expect(
      await verifyCallbackFromControlPlane(payload, { SERVICE_AUTH_SECRET: "bot-secret" })
    ).toBe(false);
    expect(await verifyCallbackFromControlPlane(payload, {})).toBe(false);
  });
});

describe("isServiceName", () => {
  it("accepts exactly the registered services", () => {
    for (const name of ["web", "slack-bot", "github-bot", "linear-bot", "modal"]) {
      expect(isServiceName(name)).toBe(true);
    }
    for (const name of ["", "WEB", "sandbox", "slackbot", "unknown"]) {
      expect(isServiceName(name)).toBe(false);
    }
  });
});
