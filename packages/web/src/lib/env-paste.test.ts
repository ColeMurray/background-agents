import { describe, expect, it } from "vitest";

import { parseMaybeEnvContent } from "./env-paste";

describe("parseMaybeEnvContent", () => {
  it("parses .env blocks and ignores comments and blank lines", () => {
    const content = `
# local dev settings
API_KEY=abc123
export DATABASE_URL="postgres://localhost:5432/app"

JWT='token==abc'
`;

    expect(parseMaybeEnvContent(content)).toEqual([
      { key: "API_KEY", value: "abc123" },
      { key: "DATABASE_URL", value: "postgres://localhost:5432/app" },
      { key: "JWT", value: "token==abc" },
    ]);
  });

  it("keeps only the last value for duplicate keys", () => {
    const content = `FOO=one\nfoo=two\nBAR=three\n`;

    expect(parseMaybeEnvContent(content)).toEqual([
      { key: "FOO", value: "two" },
      { key: "BAR", value: "three" },
    ]);
  });

  it("parses single-line key/value pastes", () => {
    expect(parseMaybeEnvContent("ONE=1")).toEqual([{ key: "ONE", value: "1" }]);
  });

  it("returns empty array for empty input", () => {
    expect(parseMaybeEnvContent("")).toEqual([]);
  });

  it("returns empty array for comments-only input", () => {
    expect(parseMaybeEnvContent("# just a comment\n# another one\n")).toEqual([]);
  });

  it("handles empty values after =", () => {
    expect(parseMaybeEnvContent("FOO=")).toEqual([{ key: "FOO", value: "" }]);
    expect(parseMaybeEnvContent('BAR=""')).toEqual([{ key: "BAR", value: "" }]);
  });

  it("handles Windows-style line endings", () => {
    expect(parseMaybeEnvContent("A=1\r\nB=2\r\n")).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "2" },
    ]);
  });

  it("handles values containing = signs", () => {
    expect(parseMaybeEnvContent("DB_URL=postgres://host/db?ssl=true&opt=1")).toEqual([
      { key: "DB_URL", value: "postgres://host/db?ssl=true&opt=1" },
    ]);
  });
});
