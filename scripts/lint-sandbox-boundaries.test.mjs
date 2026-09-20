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
});
