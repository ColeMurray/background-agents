import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? sources(path)
      : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
        ? [path]
        : [];
  });
}

describe("Sandbox lifecycle ownership boundary", () => {
  it("keeps transition/authority writes in the lifecycle owner", () => {
    const writes = new Set([
      "updateSandboxStatus",
      "transitionSandboxStatus",
      "markSandboxReady",
      "fenceSandboxGeneration",
      "updateSandboxForSpawn",
      "updateSandboxForResume",
      "updateSandboxAuthTokenHash",
    ]);
    const violations: string[] = [];
    for (const file of sources(src)) {
      const name = relative(src, file);
      // Repository CAS primitives and aggregate pending-row initialization are
      // storage responsibilities, not independent lifecycle policy owners.
      if (name === "sandbox/lifecycle/manager.ts" || name === "session/sandbox-repository.ts")
        continue;
      const ast = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true
      );
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          writes.has(node.expression.name.text)
        ) {
          violations.push(`${name}:${node.expression.name.text}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }
    expect(violations).toEqual([]);
  });

  it("does not reintroduce local ready/snapshotting policy or the old ready getter", () => {
    const consumers = [
      "session/websocket-manager.ts",
      "session/sandbox-access-reader.ts",
      "session/message-queue.ts",
      "session/sandbox-push-service.ts",
      "session/messenger.ts",
      "session/sandbox-events/runtime.handler.ts",
      "session/http/handlers/session-lifecycle.handler.ts",
    ];
    const violations: string[] = [];
    for (const name of consumers) {
      const code = readFileSync(join(src, name), "utf8");
      expect(code).not.toContain("getReadySandboxSocket");
      const ast = ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (
          ts.isBinaryExpression(node) &&
          [node.left, node.right].some(
            (side) =>
              ts.isStringLiteral(side) &&
              ["ready", "snapshotting", "spawning", "connecting", "stale"].includes(side.text)
          )
        )
          violations.push(`${name}:${node.getText(ast)}`);
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }
    expect(violations).toEqual([]);
  });
});
