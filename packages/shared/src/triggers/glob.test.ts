import { describe, it, expect } from "vitest";
import { matchGlob } from "./glob";

describe("matchGlob", () => {
  it("matches exact strings", () => {
    expect(matchGlob("main", "main")).toBe(true);
    expect(matchGlob("main", "master")).toBe(false);
  });

  it("matches single-segment wildcard (*)", () => {
    expect(matchGlob("release/*", "release/v1")).toBe(true);
    expect(matchGlob("release/*", "release/v1/hotfix")).toBe(false);
    expect(matchGlob("*.ts", "index.ts")).toBe(true);
    expect(matchGlob("*.ts", "src/index.ts")).toBe(false);
  });

  it("matches multi-segment wildcard (**)", () => {
    expect(matchGlob("src/**", "src/index.ts")).toBe(true);
    expect(matchGlob("src/**", "src/handlers/auth.ts")).toBe(true);
    expect(matchGlob("**/*.ts", "src/handlers/auth.ts")).toBe(true);
    expect(matchGlob("**/*.ts", "index.ts")).toBe(true);
    expect(matchGlob("src/**/test.ts", "src/test.ts")).toBe(true);
    expect(matchGlob("src/**/test.ts", "src/a/b/test.ts")).toBe(true);
  });

  it("handles combined wildcards", () => {
    expect(matchGlob("src/**/*.test.ts", "src/handlers/auth.test.ts")).toBe(true);
    expect(matchGlob("src/**/*.test.ts", "src/a/b/c/foo.test.ts")).toBe(true);
    expect(matchGlob("src/**/*.test.ts", "src/index.ts")).toBe(false);
  });

  it("escapes regex special characters in literal segments", () => {
    expect(matchGlob("file.txt", "file.txt")).toBe(true);
    expect(matchGlob("file.txt", "filextxt")).toBe(false);
  });
});
