import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { previewConfig, webEnvironment } from "./config";

describe("preview environment isolation", () => {
  it("overrides hostile inherited configuration and Next .env.local without changing either", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-preview-env-"));
    const hostile =
      "CONTROL_PLANE_URL=https://production.invalid\nSERVICE_AUTH_SECRET=real-secret\nNEXT_PUBLIC_WS_URL=wss://production.invalid\nNEXT_PUBLIC_APP_ICON_URL=https://production.invalid/avatar\nVERCEL=1\nGITHUB_CLIENT_SECRET=live-oauth\n";
    await writeFile(join(directory, ".env.local"), hostile);
    const parent = {
      ...process.env,
      WORKER_URL: "https://production.invalid",
      SESSION_ID: "outer-session",
      SANDBOX_AUTH_TOKEN: "outer-secret",
      AWS_SECRET_ACCESS_KEY: "live-cloud-secret",
    };
    const config = previewConfig(
      "http://127.0.0.1:3100",
      "http://127.0.0.1:3200",
      "http://127.0.0.1:3300",
      "fixture"
    );
    const env = webEnvironment(parent, config);
    try {
      const script = `const { loadEnvConfig } = require(${JSON.stringify(resolve(import.meta.dirname, "../../../../node_modules/@next/env"))});
        loadEnvConfig(process.cwd(), true);
        console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(["CONTROL_PLANE_URL", "SERVICE_AUTH_SECRET", "NEXT_PUBLIC_WS_URL", "NEXT_PUBLIC_APP_ICON_URL", "VERCEL", "GITHUB_CLIENT_SECRET", "WORKER_URL", "SESSION_ID", "SANDBOX_AUTH_TOKEN", "AWS_SECRET_ACCESS_KEY"])}.map(k => [k,process.env[k]]))));`;
      const result = await promisify(execFile)(process.execPath, ["-e", script], {
        cwd: directory,
        env,
      });
      const effective = JSON.parse(result.stdout);
      expect(effective).toEqual({
        CONTROL_PLANE_URL: config.WORKER_URL,
        SERVICE_AUTH_SECRET: config.SERVICE_AUTH_SECRET_WEB,
        NEXT_PUBLIC_WS_URL: "ws://127.0.0.1:3200",
        NEXT_PUBLIC_APP_ICON_URL: "",
        VERCEL: "",
        GITHUB_CLIENT_SECRET: "",
        WORKER_URL: "",
      });
      expect(parent.SANDBOX_AUTH_TOKEN).toBe("outer-secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
