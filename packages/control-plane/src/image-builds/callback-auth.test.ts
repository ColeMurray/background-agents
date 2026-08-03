import { describe, expect, it } from "vitest";
import { computeHmacHex } from "@open-inspect/shared/auth";
import type { Env } from "../types";
import {
  generateImageBuildCallbackToken,
  getImageBuildCallbackBearerToken,
  hashImageBuildCallbackToken,
} from "./callback-auth";

const TOKEN = generateImageBuildCallbackToken();
const ENV = { IMAGE_CALLBACK_TOKEN_PEPPER: "test-pepper" } as Env;

describe("image build callback auth", () => {
  it("generates a token with the accepted wire shape", () => {
    expect(TOKEN).toMatch(/^[a-f0-9]{64}$/);
  });

  it("hashes only under the dedicated callback pepper", async () => {
    expect(await hashImageBuildCallbackToken(TOKEN, ENV)).toBe(
      await computeHmacHex(`repo-image-callback:${TOKEN}`, "test-pepper")
    );
  });

  it("requires the dedicated callback pepper", async () => {
    await expect(hashImageBuildCallbackToken(TOKEN, {} as Env)).rejects.toThrow(
      /IMAGE_CALLBACK_TOKEN_PEPPER/
    );
  });

  it("parses only a well-formed bearer token", () => {
    expect(
      getImageBuildCallbackBearerToken(
        new Request("https://worker.test", {
          headers: { Authorization: `Bearer ${TOKEN}` },
        })
      )
    ).toBe(TOKEN);
    expect(
      getImageBuildCallbackBearerToken(
        new Request("https://worker.test", {
          headers: { Authorization: "Bearer not-a-token" },
        })
      )
    ).toBeNull();
  });
});
