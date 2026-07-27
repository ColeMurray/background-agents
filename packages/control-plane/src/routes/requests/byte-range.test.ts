import { describe, expect, it } from "vitest";
import { parseByteRangeHeader } from "./byte-range";

describe("parseByteRangeHeader", () => {
  it.each(["bytes=0x2-5", "bytes=1e2-", "bytes=+1-5", "bytes=-0x2"])(
    "rejects non-decimal range syntax: %s",
    (rangeHeader) => {
      expect(parseByteRangeHeader(rangeHeader, 10)).toBeNull();
    }
  );

  it.each([
    ["bytes=2-", { start: 2, end: 9, length: 8, totalSize: 10 }],
    ["bytes=-3", { start: 7, end: 9, length: 3, totalSize: 10 }],
  ])("continues to support valid open-ended ranges: %s", (rangeHeader, expected) => {
    expect(parseByteRangeHeader(rangeHeader, 10)).toEqual(expected);
  });
});
