import assert from "node:assert/strict";
import test from "node:test";

import { ESLint } from "eslint";

import { parseComplexityMessage } from "./lint-complexity-message.mjs";

test("parses the supported ESLint complexity diagnostic shape", async () => {
  const eslint = new ESLint({
    overrideConfigFile: true,
    ruleFilter: ({ ruleId }) => ruleId === "complexity",
    overrideConfig: {
      rules: {
        complexity: ["warn", { max: 0, variant: "classic" }],
      },
    },
  });
  const [result] = await eslint.lintText(
    "function example(value) { if (value) return 1; return 0; }"
  );
  const [message] = result.messages;

  assert.deepEqual(
    {
      ruleId: message.ruleId,
      messageId: message.messageId,
      message: message.message,
      nodeType: message.nodeType,
    },
    {
      ruleId: "complexity",
      messageId: "complex",
      message: "Function 'example' has a complexity of 2. Maximum allowed is 0.",
      nodeType: "FunctionDeclaration",
    }
  );

  assert.deepEqual(parseComplexityMessage("packages/example.ts", message), {
    file: "packages/example.ts",
    line: 1,
    column: 1,
    complexity: 2,
    description: "FunctionDeclaration",
  });
});

test("rejects an unsupported complexity diagnostic shape", () => {
  assert.throws(
    () =>
      parseComplexityMessage("packages/example.ts", {
        ruleId: "complexity",
        messageId: "unexpected",
        message: "Function 'example' has a complexity of 12. Maximum allowed is 0.",
        nodeType: "FunctionDeclaration",
        line: 4,
        column: 1,
      }),
    /Could not parse complexity at packages\/example\.ts:4:1/u
  );
});
