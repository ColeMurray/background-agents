import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

import { headers } from "next/headers";
import {
  INTERNAL_REQUEST_ID_HEADER,
  REQUEST_ID_HEADER,
  TRACE_ID_HEADER,
} from "./request-correlation";
import { getRequestCorrelation } from "./request-context";

describe("getRequestCorrelation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("ignores the public x-request-id when the internal request id is absent", async () => {
    vi.mocked(headers).mockResolvedValue(
      new Headers({
        [TRACE_ID_HEADER]: "trace-123",
        [REQUEST_ID_HEADER]: "client-request-id",
      })
    );

    const correlation = await getRequestCorrelation();

    expect(correlation.traceId).toBe("trace-123");
    expect(correlation.requestId).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(correlation.requestId).not.toBe("client-request-id");
  });

  it("reuses the normalized internal request id when present", async () => {
    vi.mocked(headers).mockResolvedValue(
      new Headers({
        [TRACE_ID_HEADER]: "trace-123",
        [INTERNAL_REQUEST_ID_HEADER]: "webhop01",
        [REQUEST_ID_HEADER]: "client-request-id",
      })
    );

    const correlation = await getRequestCorrelation();

    expect(correlation).toEqual({
      traceId: "trace-123",
      requestId: "webhop01",
    });
  });

  it("rethrows Next.js dynamic rendering errors", async () => {
    const error = Object.assign(new Error("Dynamic server usage"), {
      digest: "DYNAMIC_SERVER_USAGE",
    });
    vi.mocked(headers).mockRejectedValue(error);

    await expect(getRequestCorrelation()).rejects.toBe(error);
  });
});
