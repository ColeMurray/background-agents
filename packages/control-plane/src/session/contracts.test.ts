import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SessionInternalPaths } from "./contracts";

describe("session internal endpoint contracts", () => {
  it("uses contract constants in SessionDO and router for known endpoints", () => {
    const routerSource = readFileSync(new URL("../router.ts", import.meta.url), "utf8");
    const durableObjectSource = readFileSync(
      new URL("./durable-object.ts", import.meta.url),
      "utf8"
    );

    const routerEndpointKeys: Array<keyof typeof SessionInternalPaths> = [
      "verifySandboxToken",
      "init",
      "state",
      "prompt",
      "stop",
      "events",
      "artifacts",
      "participants",
      "messages",
      "createPr",
      "openaiTokenRefresh",
      "wsToken",
      "archive",
      "unarchive",
      "spawnContext",
      "childSessionUpdate",
      "childSummary",
      "cancel",
    ];

    for (const endpointKey of routerEndpointKeys) {
      expect(routerSource).toContain(`SessionInternalPaths.${endpointKey}`);
    }

    for (const endpointKey of Object.keys(SessionInternalPaths) as Array<
      keyof typeof SessionInternalPaths
    >) {
      expect(durableObjectSource).toContain(`SessionInternalPaths.${endpointKey}`);
    }

    expect(routerSource).not.toContain("http://internal/internal/");
    expect(durableObjectSource).not.toContain('"/internal/');
    expect(durableObjectSource).not.toContain("'/internal/");
  });
});
