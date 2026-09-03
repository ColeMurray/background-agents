/**
 * The manifest's host contracts point at real tests: each named file contains
 * a test with exactly that title, so a host that ports the suite can find what
 * it must implement and a rename here cannot silently orphan a contract.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SESSION_CORE_CONFORMANCE_MANIFEST } from "./session-core-conformance";

const packageRoot = resolve(__dirname, "../..");

describe("session-core conformance manifest", () => {
  const hostContracts = SESSION_CORE_CONFORMANCE_MANIFEST.filter(
    (
      entry
    ): entry is Extract<(typeof SESSION_CORE_CONFORMANCE_MANIFEST)[number], { scope: "host" }> =>
      entry.scope === "host"
  );

  it("names a test for every host contract", () => {
    expect(hostContracts.map(({ id }) => id)).toEqual([
      "host.concurrent-prompt-claim",
      "host.socket-terminal-upgrade",
      "host.socket-single-sandbox",
      "host.socket-ack-redelivery",
    ]);
  });

  it.each(hostContracts)("$id is implemented under its title", ({ test, title }) => {
    const source = readFileSync(resolve(packageRoot, test), "utf8");
    expect(source).toContain(`it("${title}"`);
  });
});
