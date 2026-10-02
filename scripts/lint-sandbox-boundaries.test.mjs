import assert from "node:assert/strict";
import test from "node:test";
import { ESLint } from "eslint";

const eslint = new ESLint();

test("new consumers and platform adapters cannot import sandbox implementations", async () => {
  for (const filePath of [
    "packages/control-plane/src/session/new-consumer.ts",
    "packages/control-plane/src/node/new-consumer.ts",
    "packages/control-plane/src/node/host.ts",
    "packages/control-plane/src/cloudflare/durable-object.ts",
    "packages/control-plane/src/index.ts",
  ]) {
    for (const [name, source] of [
      ["SandboxRepository", "../session/sandbox-repository"],
      ["SandboxLifecycleManager", "../sandbox/lifecycle/manager"],
      ["SandboxAccess", "../sandbox/lifecycle/sandbox-access"],
      ["VmStartupReconciliation", "../sandbox/lifecycle/vm-startup-reconciliation"],
      ["AllocationCleanupDependencies", "../sandbox/lifecycle/allocation-cleanup"],
      ["ProviderStopOutcome", "../sandbox/lifecycle/provider-stop"],
      ["WatchdogEffectsDependencies", "../sandbox/lifecycle/watchdog-effects"],
    ]) {
      const [result] = await eslint.lintText(
        `import type { ${name} } from "${source}"; export type Dependency = ${name};`,
        { filePath }
      );
      assert.ok(
        result.messages.some((message) => message.ruleId === "no-restricted-imports"),
        `${filePath} must reject ${name}`
      );
    }
  }
});

test("focused ports remain usable by consumers and extracted lifecycle modules", async () => {
  for (const filePath of [
    "packages/control-plane/src/session/new-consumer.ts",
    "packages/control-plane/src/sandbox/lifecycle/readiness.ts",
  ]) {
    const [result] = await eslint.lintText(
      'import type { SandboxReadiness } from "../sandbox/lifecycle/ports"; export type Dependency = SandboxReadiness;',
      { filePath }
    );
    assert.equal(result.errorCount, 0, JSON.stringify(result.messages));
  }
  const [access] = await eslint.lintText(
    'import type { SandboxAccess } from "./sandbox-access"; export type Dependency = SandboxAccess;',
    { filePath: "packages/control-plane/src/sandbox/lifecycle/reconciliation.ts" }
  );
  assert.equal(access.errorCount, 0, JSON.stringify(access.messages));
  const [reconciliation] = await eslint.lintText(
    'import type { VmStartupReconciliation } from "./vm-startup-reconciliation"; export type Dependency = VmStartupReconciliation;',
    { filePath: "packages/control-plane/src/sandbox/lifecycle/manager.ts" }
  );
  assert.equal(reconciliation.errorCount, 0, JSON.stringify(reconciliation.messages));
  const [cleanup] = await eslint.lintText(
    'import { attemptRejectedStartupCleanup } from "./allocation-cleanup"; export const cleanup = attemptRejectedStartupCleanup;',
    { filePath: "packages/control-plane/src/sandbox/lifecycle/manager.ts" }
  );
  assert.equal(cleanup.errorCount, 0, JSON.stringify(cleanup.messages));
  const [watchdog] = await eslint.lintText(
    'import { terminateStaleHeartbeat } from "./watchdog-effects"; export const effect = terminateStaleHeartbeat;',
    { filePath: "packages/control-plane/src/sandbox/lifecycle/manager.ts" }
  );
  assert.equal(watchdog.errorCount, 0, JSON.stringify(watchdog.messages));
});
