import { describe, expect, it } from "vitest";
import { buildVercelBootstrapScript } from "./bootstrap";

describe("buildVercelBootstrapScript", () => {
  it("installs the sandbox toolchain contract", () => {
    const script = buildVercelBootstrapScript();

    expect(script).toContain(
      "printf '%s\\n' '#!/bin/sh' 'exec /usr/bin/python3.12 -m sandbox_runtime.credentials.git_credential_helper \"$@\"'"
    );
    expect(script).toContain("sudo tee /usr/local/bin/oi-git-credentials >/dev/null");
    expect(script).toContain(
      "sudo git config --system credential.helper /usr/local/bin/oi-git-credentials || true"
    );
    expect(script).toContain("sudo git config --system credential.useHttpPath true || true");

    expect(script).toContain(
      '{"name":"opencode-tools","type":"module","dependencies":{"@opencode-ai/plugin":"$OPENCODE_VERSION"}}'
    );
    expect(script).toContain(
      "sudo mv /tmp/opencode-deps-package.json /app/opencode-deps/package.json"
    );
    expect(script).toContain("cd /app/opencode-deps");
    expect(script).toContain("sudo npm install --ignore-scripts --no-audit --no-fund");
    expect(script).toContain("sudo mkdir -p /root/.config/opencode");
    expect(script).toContain("sudo cp -a /app/opencode-deps/. /root/.config/opencode/");

    expect(script).toContain(
      "sudo /usr/bin/python3.12 -m pip install --break-system-packages -e packages/sandbox-runtime"
    );
  });
});
