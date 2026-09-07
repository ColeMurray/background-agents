import { describe, expect, it } from "vitest";
import { buildVercelBootstrapScript } from "../../../../../vercel-infra/src/bootstrap";

describe("buildVercelBootstrapScript", () => {
  it("delegates installation to the staged, provider-neutral bundle", () => {
    const script = buildVercelBootstrapScript();
    expect(script).toContain("/packages/sandbox-images/install/install.sh");
    expect(script).not.toContain("npm install");
  });

  it("uses the runtime-visible system Git during installation", () => {
    const script = buildVercelBootstrapScript();
    expect(script).toContain(
      "sudo -E env PATH='/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' bash"
    );
  });
});
