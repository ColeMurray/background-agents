import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const obsoleteIdentifiers = ["NEXT_PUBLIC_GOOGLE_ENABLED", "GOOGLE_LOGIN_ENABLED"];
const thisTest = "packages/web/src/lib/provider-authority-boundary.test.ts";

describe("sign-in provider authority boundary", () => {
  it("keeps retired web-owned provider flags out of tracked repository files", () => {
    const trackedFiles = execFileSync("git", ["ls-files"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter((file) => file && file !== thisTest);
    const violations = trackedFiles.flatMap((file) => {
      const source = readFileSync(resolve(repositoryRoot, file), "utf8");
      return obsoleteIdentifiers
        .filter((identifier) => source.includes(identifier))
        .map((identifier) => `${file}: ${identifier}`);
    });

    expect(violations).toEqual([]);
  });
});
