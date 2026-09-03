/**
 * Every host contract is declared somewhere in the host's integration suites
 * through `hostContract(id, …)`, which owns the title and has no skipped form.
 * The scan is what makes omission visible: a host that forgets a contract
 * fails here rather than silently running fewer tests.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HOST_CONTRACTS,
  SESSION_CORE_CONFORMANCE_MANIFEST,
  STORAGE_CONTRACTS,
  type HostContractId,
} from "./session-core-conformance";

const integrationDir = resolve(__dirname, "../integration");

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
});
