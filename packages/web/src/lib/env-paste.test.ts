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

  it("does not treat single-line paste as env block import", () => {
    expect(parseMaybeEnvContent("ONE=1")).toEqual([]);
  });
});
