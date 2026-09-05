/**
 * Every host contract is declared somewhere in the host's integration suites
 * through `hostContract(id, …)`, which owns the title and has no skipped form,
 * and every storage lane registers the whole storage suite. The scan is what
 * makes omission visible: a host that forgets a contract, or a lane that stops
 * registering the suite, fails here rather than silently running fewer tests.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HOST_CONTRACTS,
  SESSION_CORE_CONFORMANCE_MANIFEST,
  STORAGE_CONTRACTS,
  type HostContractId,
} from "./session-core-conformance";

const integrationDir = resolve(__dirname, "../integration");

/**
 * The storage lanes and the file that registers the suite for each. Both run
 * in CI: the node:sqlite lane in `test-cp-unit`, the Durable Object lane in
 * `test-cp-integration`.
 */
const STORAGE_LANES: Record<string, string> = {
  "node:sqlite": join(__dirname, "session-core-conformance.node.test.ts"),
  "Durable Object storage": join(integrationDir, "session-core-conformance.test.ts"),
};

function declaredHostContracts(): Map<HostContractId, string[]> {
  const declared = new Map<HostContractId, string[]>();
  for (const file of readdirSync(integrationDir).filter((name) => name.endsWith(".test.ts"))) {
    const source = readFileSync(join(integrationDir, file), "utf8");
    for (const id of Object.keys(HOST_CONTRACTS) as HostContractId[]) {
      if (source.includes(`hostContract("${id}"`)) {
        declared.set(id, [...(declared.get(id) ?? []), file]);
      }
    }
  }
  return declared;
}

describe("session-core conformance manifest", () => {
  it("lists every storage and host contract exactly once", () => {
    expect(SESSION_CORE_CONFORMANCE_MANIFEST.map(({ id }) => id)).toEqual([
      ...Object.keys(STORAGE_CONTRACTS),
      ...Object.keys(HOST_CONTRACTS),
    ]);
  });

  it.each(Object.keys(HOST_CONTRACTS) as HostContractId[])(
    "%s is declared by the Cloudflare host",
    (id) => {
      expect(declaredHostContracts().get(id) ?? []).not.toEqual([]);
    }
  );

  it.each(Object.entries(STORAGE_LANES))(
    "the %s lane registers every storage contract",
    (_lane, file) => {
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf8")).toContain("registerSessionCoreConformanceSuite(");
    }
  );
});
