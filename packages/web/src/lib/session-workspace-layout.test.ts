import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sessionPagePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../app/(app)/session/[id]/page.tsx"
);

describe("session workspace layout", () => {
  it("allows the mobile workspace to shrink around long timeline content", () => {
    const source = readFileSync(sessionPagePath, "utf8");

    expect(source).toContain(
      'className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-clip"'
    );
  });
});
