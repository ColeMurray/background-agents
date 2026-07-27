import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const resourceRoutePath = "packages/web/src/app/api/example/route.ts";
const authRoutePath = "packages/web/src/app/api/auth/example/route.ts";

const eslint = new ESLint({ cwd: repositoryRoot });

async function restrictedImportMessages(source: string, filePath = resourceRoutePath) {
  const [result] = await eslint.lintText(source, { filePath });
  return result.messages.filter((message) => message.ruleId === "no-restricted-imports");
}

describe("server authentication import boundary", () => {
  it.each([
    {
      description: "the authentication framework module",
      source: 'import NextAuth from "next-auth";',
    },
    {
      description: "the aliased auth implementation",
      source: 'import { authOptions } from "@/lib/auth";',
    },
    {
      description: "a relative path to the auth implementation",
      source: 'import { authOptions } from "../../../lib/auth";',
    },
  ])("rejects $description", async ({ source }) => {
    await expect(restrictedImportMessages(source)).resolves.toHaveLength(1);
  });

  it("allows resource routes to import the server-auth seam", async () => {
    await expect(
      restrictedImportMessages('import { getServerAuthSession } from "@/lib/server-auth-session";')
    ).resolves.toHaveLength(0);
  });

  it("rejects framework imports from auth proxy endpoints", async () => {
    await expect(
      restrictedImportMessages('import NextAuth from "next-auth";', authRoutePath)
    ).resolves.toHaveLength(1);
  });
});
