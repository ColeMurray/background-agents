import { describe, expect, it } from "vitest";
import { adaptExternalRuntimeFailure } from "./runtime-response";

describe("external runtime response adapter", () => {
  it.each([
    [400, 400, "runtime_bad_request"],
    [404, 404, "runtime_not_found"],
    [409, 409, "runtime_conflict"],
    [410, 410, "event_checkpoint_expired"],
    [429, 429, "runtime_busy"],
    [500, 503, "runtime_unavailable"],
    [418, 502, "runtime_error"],
  ])("maps internal status %s to a bounded external error", async (internal, external, code) => {
    const secret = "database password=hunter2";
    const result = adaptExternalRuntimeFailure(
      new Response(JSON.stringify({ error: secret, stack: secret }), { status: internal })
    );

    expect(result?.status).toBe(external);
    const body = await result!.text();
    expect(JSON.parse(body)).toMatchObject({ code });
    expect(body).not.toContain(secret);
  });

  it("returns null for successful internal responses", () => {
    expect(adaptExternalRuntimeFailure(Response.json({ internal: true }))).toBeNull();
  });
});
