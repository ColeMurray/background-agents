import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const componentPath = "packages/web/src/components/example.tsx";
const hookPath = "packages/web/src/hooks/example.ts";
const clientLibraryPath = "packages/web/src/lib/example-client.ts";
const authSessionPath = "packages/web/src/lib/auth-session.tsx";
const browserApiFetchPath = "packages/web/src/lib/browser-api-fetch.ts";
const controlPlaneTransportPath = "packages/web/src/lib/control-plane-transport.ts";

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

  it("rejects raw fetch calls from an ordinary client library", async () => {
    await expect(
      boundaryMessages('fetch("/api/sessions");', clientLibraryPath)
    ).resolves.toHaveLength(1);
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

  it("keeps the app-owned auth seam framework-independent", async () => {
    await expect(
      boundaryMessages('import { useSession } from "next-auth/react";', authSessionPath)
    ).resolves.toHaveLength(1);
  });

  it("allows the browser request seam to own fetch", async () => {
    await expect(
      boundaryMessages('fetch("/api/sessions");', browserApiFetchPath)
    ).resolves.toHaveLength(0);
  });

  it("allows the server request seam to own fetch", async () => {
    await expect(
      boundaryMessages('fetch("https://control-plane.example");', controlPlaneTransportPath)
    ).resolves.toHaveLength(0);
  });
});
