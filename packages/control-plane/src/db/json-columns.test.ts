import { describe, expect, it } from "vitest";
import { parseJsonStringArray } from "./json-columns";

describe("parseJsonStringArray", () => {
  it("parses a well-formed string array", () => {
    expect(parseJsonStringArray('["C1","C2"]')).toEqual(["C1", "C2"]);
    expect(parseJsonStringArray("[]")).toEqual([]);
  });

  it("reads NULL and empty values as unset", () => {
    expect(parseJsonStringArray(null)).toBeUndefined();
    expect(parseJsonStringArray("")).toBeUndefined();
  });

  it("reads corrupt values as unset instead of failing the row", () => {
    expect(parseJsonStringArray("not json")).toBeUndefined();
    expect(parseJsonStringArray('{"a":1}')).toBeUndefined();
    expect(parseJsonStringArray('"C1"')).toBeUndefined();
  });

  it("rejects arrays containing non-string elements (the string[] contract)", () => {
    expect(parseJsonStringArray('["C1", 42, null]')).toBeUndefined();
    expect(parseJsonStringArray("[42]")).toBeUndefined();
    expect(parseJsonStringArray('[["C1"]]')).toBeUndefined();
  });
});
