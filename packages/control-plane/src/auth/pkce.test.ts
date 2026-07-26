import { describe, expect, it } from "vitest";
import { InvalidPkceVerifierError, createPkceS256Challenge } from "./pkce";

describe("createPkceS256Challenge", () => {
  it("matches the RFC 7636 S256 test vector", async () => {
    await expect(
      createPkceS256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
    ).resolves.toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("rejects verifiers outside the RFC 7636 syntax and length bounds", async () => {
    await expect(createPkceS256Challenge("too-short")).rejects.toBeInstanceOf(
      InvalidPkceVerifierError
    );
    await expect(createPkceS256Challenge("*".repeat(43))).rejects.toBeInstanceOf(
      InvalidPkceVerifierError
    );
  });
});
