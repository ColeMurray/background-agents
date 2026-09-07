import { describe, expect, it } from "vitest";
import { buildVercelBootstrapScript } from "../../../../../vercel-infra/src/bootstrap";

describe("buildVercelBootstrapScript", () => {
  it("delegates installation to the staged, provider-neutral bundle", () => {
    const script = buildVercelBootstrapScript();
    expect(script).toContain("sudo -E bash");
    expect(script).toContain("/packages/sandbox-images/install/install.sh");
    expect(script).not.toContain("npm install");
  });
});
