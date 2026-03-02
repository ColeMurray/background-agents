import { describe, it, expect, vi } from "vitest";
import { DOFetcherAdapter } from "./do-fetcher-adapter";

function createMockNamespace() {
  const stubFetch = vi.fn<(input: RequestInfo, init?: RequestInit) => Promise<Response>>();
  const stub = { fetch: stubFetch } as unknown as DurableObjectStub;
  const fakeId = { toString: () => "fake-do-id" } as DurableObjectId;

  const ns = {
    idFromName: vi.fn().mockReturnValue(fakeId),
    get: vi.fn().mockReturnValue(stub),
  } as unknown as DurableObjectNamespace;

  return { ns, stubFetch, fakeId };
}

describe("DOFetcherAdapter", () => {
  it("resolves DO stub from namespace and delegates fetch", async () => {
    const { ns, stubFetch, fakeId } = createMockNamespace();
    stubFetch.mockResolvedValue(new Response("ok", { status: 200 }));

    const adapter = new DOFetcherAdapter(ns, "global-scheduler");
    const response = await adapter.fetch("https://internal/internal/tick", {
      method: "POST",
    });

    expect(ns.idFromName).toHaveBeenCalledWith("global-scheduler");
    expect(ns.get).toHaveBeenCalledWith(fakeId);
    expect(stubFetch).toHaveBeenCalledWith("https://internal/internal/tick", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("passes through request init options", async () => {
    const { ns, stubFetch } = createMockNamespace();
    stubFetch.mockResolvedValue(Response.json({ ok: true }));

    const adapter = new DOFetcherAdapter(ns, "global-scheduler");
    await adapter.fetch("https://internal/internal/run-complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: "run-1" }),
    });

    const [, init] = stubFetch.mock.calls[0];
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(init?.body).toContain("run-1");
  });

  it("resolves a fresh stub on each fetch call", async () => {
    const { ns, stubFetch } = createMockNamespace();
    stubFetch.mockResolvedValue(new Response("ok"));

    const adapter = new DOFetcherAdapter(ns, "global-scheduler");
    await adapter.fetch("https://internal/a");
    await adapter.fetch("https://internal/b");

    expect(ns.idFromName).toHaveBeenCalledTimes(2);
    expect(ns.get).toHaveBeenCalledTimes(2);
  });

  it("throws on connect()", () => {
    const { ns } = createMockNamespace();
    const adapter = new DOFetcherAdapter(ns, "global-scheduler");

    expect(() => adapter.connect("127.0.0.1:8080")).toThrow(
      "DOFetcherAdapter does not support connect()"
    );
  });
});
