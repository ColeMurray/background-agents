import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  EXECUTION_ARTIFACT_INPUTS,
  verifyExecutionIsolationEvidence,
} from "./attest-execution-isolation.mjs";

const root = new URL("../", import.meta.url);

async function digest() {
  const hash = createHash("sha256");
  for (const path of EXECUTION_ARTIFACT_INPUTS) {
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(new URL(path, root)));
  }
  return hash.digest("hex");
}

test("all provider adapters remain explicitly blocked without live isolation proof", async () => {
  const runtime = JSON.parse(
    await readFile(
      new URL("packages/sandbox-runtime/src/sandbox_runtime/runtime_manifest.json", root)
    )
  );
  const providers = Object.fromEntries(
    ["modal", "modal-vm", "opencomputer", "daytona", "vercel", "e2b"].map((provider) => [
      provider,
      { status: "canary_blocked", limitations: ["No live provider isolation canary recorded"] },
    ])
  );
  const evidence = {
    runtimeVersion: runtime.runtimeVersion,
    artifactSha256: await digest(),
    providers,
  };

  await assert.doesNotReject(verifyExecutionIsolationEvidence(evidence));
  await assert.rejects(
    verifyExecutionIsolationEvidence({
      ...evidence,
      providers: { ...providers, e2b: { status: "passed", attacks: {} } },
    }),
    /did not pass every isolation attack/
  );
});

test("the canary verifier is read-only", async () => {
  const source = await readFile(new URL("scripts/attest-execution-isolation.mjs", root), "utf8");
  assert.doesNotMatch(source, /fetch\(|wrangler|modal deploy|railway|daytona create/i);
});
