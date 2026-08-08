import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { SessionState } from "@open-inspect/shared";
import { encryptToken } from "../../src/auth/crypto";
import type { SessionDO } from "../../src/session/durable-object";
import { initSession, queryDO } from "./helpers";

describe("VNC session state", () => {
  it("hydrates the VNC URL and decrypted password", async () => {
    const { stub } = await initSession();
    const password = "vnc-secret";
    const encrypted = await encryptToken(password, env.REPO_SECRETS_ENCRYPTION_KEY);
    await queryDO(
      stub,
      "UPDATE sandbox SET vnc_url = ?, vnc_password = ?",
      "https://vnc.test",
      encrypted
    );

    const state = await runInDurableObject(stub, (instance: SessionDO) =>
      (instance as unknown as { getSessionState(): Promise<SessionState> }).getSessionState()
    );

    expect(state.vncUrl).toBe("https://vnc.test");
    expect(state.vncPassword).toBe(password);
  });
});
