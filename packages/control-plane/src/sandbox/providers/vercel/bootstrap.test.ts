import { describe, expect, it } from "vitest";
import { buildVercelBootstrapScript } from "./bootstrap";

describe("buildVercelBootstrapScript", () => {
  it("installs shared sandbox helpers and stages OpenCode deps", () => {
    const script = buildVercelBootstrapScript();

    expect(script).toContain("install_git_credential_helper() {");
    expect(script).toContain(
      "printf '%s\\n' '#!/bin/sh' 'exec /usr/bin/python3.12 -m sandbox_runtime.credentials.git_credential_helper \"$@\"'"
    );
    expect(script).toContain("sudo git config --system credential.useHttpPath true || true");
    expect(script).toContain("stage_opencode_deps() {");
    expect(script).toContain("sudo npm install --ignore-scripts --no-audit --no-fund");
    expect(script).toContain("sudo cp -a /app/opencode-deps/. /root/.config/opencode/");
    expect(script).toContain("install_git_credential_helper\nstage_opencode_deps");
  });
});
