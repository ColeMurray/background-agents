import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { browserApiFetch } from "./browser-api-fetch";
import { fetchTeamSnapshot, isRetryableTeamError, TeamRequestError } from "./team-snapshot";

vi.mock("./browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));

const path = "/api/teams";
const schema = z.object({ name: z.string(), archived: z.boolean().default(false) });

beforeEach(() => vi.resetAllMocks());

describe("fetchTeamSnapshot", () => {
  it("returns a ready snapshot with the schema's parsed defaults", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(Response.json({ name: "Design", unknown: true }));
    await expect(fetchTeamSnapshot(path, schema)).resolves.toEqual({
      kind: "ready",
      value: { name: "Design", archived: false },
    });
    expect(browserApiFetch).toHaveBeenCalledWith(path);
  });

  it.each([401, 403, 404])("returns an authoritative denial for HTTP %s", async (status) => {
    vi.mocked(browserApiFetch).mockResolvedValue(Response.json({}, { status }));
    const snapshot = await fetchTeamSnapshot(path, schema);
    expect(snapshot.kind).toBe("denied");
    if (snapshot.kind !== "denied") throw new Error("Expected a denied snapshot");
    expect(snapshot.error).toBeInstanceOf(TeamRequestError);
    expect(snapshot.error.disposition).toBe("authoritative-denial");
    expect(snapshot.error.message).toContain(String(status));
    expect(isRetryableTeamError(snapshot.error)).toBe(false);
  });

  it.each(["invalid-json", "invalid-schema"] as const)(
    "returns an invalid-payload denial for %s",
    async (failure) => {
      vi.mocked(browserApiFetch).mockResolvedValue(
        failure === "invalid-json" ? new Response("Invalid JSON") : Response.json({ name: 42 })
      );
      const snapshot = await fetchTeamSnapshot(path, schema);
      expect(snapshot.kind).toBe("denied");
      if (snapshot.kind !== "denied") throw new Error("Expected a denied snapshot");
      expect(snapshot.error).toBeInstanceOf(TeamRequestError);
      expect(snapshot.error.disposition).toBe("invalid-payload");
      expect(isRetryableTeamError(snapshot.error)).toBe(false);
    }
  );

  it.each([408, 429, 500, 503, 599])("throws a transient error for HTTP %s", async (status) => {
    vi.mocked(browserApiFetch).mockResolvedValue(Response.json({}, { status }));
    const request = fetchTeamSnapshot(path, schema);
    await expect(request).rejects.toBeInstanceOf(TeamRequestError);
    await expect(request).rejects.toMatchObject({ disposition: "transient" });
  });

  it("throws a transient error for a network failure", async () => {
    vi.mocked(browserApiFetch).mockRejectedValue(new TypeError("Network unavailable"));
    const request = fetchTeamSnapshot(path, schema);
    await expect(request).rejects.toBeInstanceOf(TeamRequestError);
    await expect(request).rejects.toMatchObject({ disposition: "transient" });
  });

  it("treats an interrupted response body as transport failure, not invalid payload", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new TypeError("Connection interrupted"));
      },
    });
    vi.mocked(browserApiFetch).mockResolvedValue(new Response(body));
    await expect(fetchTeamSnapshot(path, schema)).rejects.toMatchObject({
      disposition: "transient",
    });
  });

  it.each([400, 409, 422])("throws a non-retryable request error for HTTP %s", async (status) => {
    vi.mocked(browserApiFetch).mockResolvedValue(Response.json({}, { status }));
    const request = fetchTeamSnapshot(path, schema);
    await expect(request).rejects.toBeInstanceOf(TeamRequestError);
    await expect(request).rejects.toMatchObject({ disposition: "request-error" });
  });
});

describe("isRetryableTeamError", () => {
  it.each(["transient", "authoritative-denial", "invalid-payload", "request-error"] as const)(
    "retries disposition %s only when it is transient",
    (disposition) => {
      expect(isRetryableTeamError(new TeamRequestError("Failure", disposition))).toBe(
        disposition === "transient"
      );
    }
  );

  it.each([
    undefined,
    null,
    new Error("Unknown failure"),
    { retryable: true },
    { disposition: "transient" },
  ])("does not retry an unrecognized error %j", (error) =>
    expect(isRetryableTeamError(error)).toBe(false)
  );
});
