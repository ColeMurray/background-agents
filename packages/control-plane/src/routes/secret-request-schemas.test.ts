import { describe, expect, it } from "vitest";
import {
  environmentSecretsImportBodySchema,
  secretsRequestBodySchema,
} from "./secret-request-schemas";

describe("secret request schemas", () => {
  it("parses a valid secrets write body", () => {
    const parsed = secretsRequestBodySchema.safeParse({ secrets: { TOKEN: "value" } });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.secrets.TOKEN).toBe("value");
  });

  it("preserves an own __proto__ key for canonical secret normalization", () => {
    const input = JSON.parse('{"secrets":{"__proto__":"value"}}') as unknown;
    const parsed = secretsRequestBodySchema.safeParse(input);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.prototype.hasOwnProperty.call(parsed.data.secrets, "__proto__")).toBe(true);
      expect(parsed.data.secrets.__proto__).toBe("value");
    }
  });

  it("rejects malformed secrets write bodies", () => {
    expect(secretsRequestBodySchema.safeParse({}).success).toBe(false);
    expect(secretsRequestBodySchema.safeParse({ secrets: { TOKEN: 123 } }).success).toBe(false);
  });

  it("parses a valid environment secret import body with optional keys", () => {
    const parsed = environmentSecretsImportBodySchema.safeParse({
      repoOwner: " Acme ",
      repoName: " App ",
      keys: ["TOKEN"],
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ repoOwner: "acme", repoName: "app", keys: ["TOKEN"] });
    }
  });

  it("parses an environment secret import body without keys", () => {
    const parsed = environmentSecretsImportBodySchema.safeParse({
      repoOwner: "acme",
      repoName: "app",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.keys).toBeUndefined();
  });

  it("rejects malformed environment secret import bodies", () => {
    expect(environmentSecretsImportBodySchema.safeParse({ repoOwner: "acme" }).success).toBe(false);
    expect(
      environmentSecretsImportBodySchema.safeParse({ repoOwner: "   ", repoName: "app" }).success
    ).toBe(false);
    expect(
      environmentSecretsImportBodySchema.safeParse({
        repoOwner: "acme",
        repoName: "app",
        keys: [123],
      }).success
    ).toBe(false);
  });
});
