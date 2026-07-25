import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const componentPath = "packages/web/src/components/example.tsx";
const hookPath = "packages/web/src/hooks/example.ts";
const authSessionPath = "packages/web/src/lib/auth-session.tsx";
const browserApiFetchPath = "packages/web/src/lib/browser-api-fetch.ts";

const eslint = new ESLint({ cwd: repositoryRoot });

async function boundaryMessages(source: string, filePath: string) {
  const [result] = await eslint.lintText(source, { filePath });
  return result.messages.filter(
    (message) =>
      message.ruleId === "no-restricted-imports" || message.ruleId === "no-restricted-globals"
  );
}

describe("client authentication boundaries", () => {
  it("rejects direct client imports from NextAuth", async () => {
    await expect(
      boundaryMessages('import { useSession } from "next-auth/react";', componentPath)
    ).resolves.toHaveLength(1);
  });

  it("rejects raw browser fetch calls", async () => {
    await expect(boundaryMessages('fetch("/api/sessions");', hookPath)).resolves.toHaveLength(1);
  });

  it("allows consumers to use the app-owned boundaries", async () => {
    await expect(
      boundaryMessages(
        [
          'import { useAuthSession } from "@/lib/auth-session";',
          'import { browserApiFetch } from "@/lib/browser-api-fetch";',
        ].join("\n"),
        componentPath
      )
    ).resolves.toHaveLength(0);
  });

  it("allows the auth seam to own the NextAuth client integration", async () => {
    await expect(
      boundaryMessages('import { useSession } from "next-auth/react";', authSessionPath)
    ).resolves.toHaveLength(0);
  });

  it("allows the browser request seam to own fetch", async () => {
    await expect(
      boundaryMessages('fetch("/api/sessions");', browserApiFetchPath)
    ).resolves.toHaveLength(0);
  });
});
