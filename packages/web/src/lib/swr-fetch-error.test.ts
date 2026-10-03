import { describe, expect, it } from "vitest";
import { SwrFetchError, isRetryableFetchError, usableFetchData } from "./swr-fetch-error";

describe("isRetryableFetchError", () => {
  it.each([408, 429, 500, 502, 503, 504])("retries HTTP %i", (status) => {
    expect(isRetryableFetchError(new SwrFetchError(status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 405, 409, 410, 422, 451])("does not retry HTTP %i", (status) => {
    expect(isRetryableFetchError(new SwrFetchError(status))).toBe(false);
  });

  it.each([new TypeError("Failed to fetch"), new Error("Invalid response")])(
    "retries a failure without an HTTP response (%s)",
    (error) => {
      expect(isRetryableFetchError(error)).toBe(true);
    }
  );
});

describe("usableFetchData", () => {
  const data = { rows: [1] };

  it("keeps data without an error or after a retryable failure", () => {
    expect(usableFetchData(data, undefined)).toBe(data);
    expect(usableFetchData(data, new SwrFetchError(503))).toBe(data);
  });

  it("drops data after a non-retryable failure", () => {
    expect(usableFetchData(data, new SwrFetchError(403))).toBeUndefined();
    expect(usableFetchData(data, new SwrFetchError(422))).toBeUndefined();
  });
});
