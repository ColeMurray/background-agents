import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SessionInternalPaths } from "./contracts";

describe("session internal endpoint contracts", () => {
  it("uses contract constants in internal route wiring and router for known endpoints", () => {
    const routerSource = readFileSync(new URL("../router.ts", import.meta.url), "utf8");
    const sessionRouteSources = [
      "../routes/session-create.ts",
      "../routes/session-runtime-proxy.ts",
      "../routes/session-ws-token.ts",
      "../routes/session-prompt.ts",
      "../routes/session-media.ts",
      "../routes/session-media-artifacts.ts",
      "../routes/session-media-stream.ts",
      "../routes/session-media-upload.ts",
      "../routes/session-child-spawn.ts",
      "../routes/session-children.ts",
    ]
      .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
      .join("\n");
    const runtimeClientSource = readFileSync(
      new URL("./runtime-client.ts", import.meta.url),
      "utf8"
    );
    const initializeSource = readFileSync(new URL("./initialize.ts", import.meta.url), "utf8");
    const routesSource = readFileSync(new URL("./http/routes.ts", import.meta.url), "utf8");
    const durableObjectSource = readFileSync(
      new URL("./durable-object.ts", import.meta.url),
      "utf8"
    );

    // "init" is used in session/initialize.ts (extracted from router)
    expect(initializeSource).toContain("SessionInternalPaths.init");

    for (const endpointKey of Object.keys(SessionInternalPaths) as Array<
      keyof typeof SessionInternalPaths
    >) {
      expect(routesSource).toContain(`SessionInternalPaths.${endpointKey}`);
    }

    expect(durableObjectSource).toContain("createSessionInternalRoutes");
    expect(runtimeClientSource).toContain("buildSessionInternalUrl");
    const externalSessionSource = `${routerSource}\n${sessionRouteSources}`;
    expect(externalSessionSource).not.toContain("http://internal/internal/");
    expect(runtimeClientSource).not.toContain("http://internal/internal/");
    expect(routesSource).not.toContain('"/internal/');
    expect(routesSource).not.toContain("'/internal/");
  });
});
