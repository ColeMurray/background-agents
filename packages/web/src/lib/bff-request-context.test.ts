import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

import { headers } from "next/headers";
import { INTERNAL_BFF_REQUEST_ID_HEADER, REQUEST_ID_HEADER } from "./bff-correlation";
import { getBffRequestCorrelation } from "./bff-request-context";

describe("getBffRequestCorrelation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("ignores the public x-request-id when the internal BFF request id is absent", async () => {
    vi.mocked(headers).mockResolvedValue(
      new Headers({
        "x-trace-id": "trace-123",
        [REQUEST_ID_HEADER]: "client-request-id",
      })
    );

    const correlation = await getBffRequestCorrelation();

    expect(correlation.traceId).toBe("trace-123");
    expect(correlation.requestId).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(correlation.requestId).not.toBe("client-request-id");
  });

  it("reuses the normalized internal BFF request id when present", async () => {
    vi.mocked(headers).mockResolvedValue(
      new Headers({
        "x-trace-id": "trace-123",
        [INTERNAL_BFF_REQUEST_ID_HEADER]: "bffhop01",
        [REQUEST_ID_HEADER]: "client-request-id",
      })
    );

    const correlation = await getBffRequestCorrelation();

    expect(correlation).toEqual({
      traceId: "trace-123",
      requestId: "bffhop01",
    });
  });
});
