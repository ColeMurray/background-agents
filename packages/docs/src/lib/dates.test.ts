import { describe, expect, it } from "vitest";

import { formatReviewDate } from "./dates";

describe("review date formatting", () => {
  it("renders the calendar date without a time zone shift", () => {
    expect(formatReviewDate("2026-09-04")).toBe("September 4, 2026");
    expect(formatReviewDate("2026-01-01")).toBe("January 1, 2026");
  });
});
