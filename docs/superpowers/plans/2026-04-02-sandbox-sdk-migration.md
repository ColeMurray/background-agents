# Sandbox SDK Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw `@cloudflare/containers` approach with `@cloudflare/sandbox` SDK, matching
the working c3po project pattern. The Sandbox SDK handles container lifecycle, networking, and
provides `exec()`, `writeFile()`, `gitCheckout()` APIs.

**Architecture:** Instead of running a Python bridge inside the container that connects back to the
control plane via WebSocket, the control plane calls INTO the sandbox using the SDK. The sandbox
runs OpenCode, and the control plane orchestrates it via `exec()` and process management.

**Tech Stack:** `@cloudflare/sandbox`, Docker (`cloudflare/sandbox:0.7.18` base), TypeScript

---

## Key Architecture Change

```
BEFORE (broken):
  Control Plane → Container.start() → Python bridge connects OUT to control plane via WebSocket

AFTER (working, matches c3po):
  Control Plane → getSandbox() → sandbox.exec() calls INTO the container
  Export { Sandbox } from '@cloudflare/sandbox' — auto-handles lifecycle
```

The Python bridge (packages/sandbox-runtime) is NOT used in Phase 1. Instead:

1. `getSandbox(env.SANDBOX, sessionId)` gets a sandbox instance
2. `sandbox.setEnvVars()` configures credentials
3. `sandbox.gitCheckout()` clones the repo
4. `sandbox.exec('.openinspect/setup.sh')` runs setup
5. `sandbox.startProcess('opencode server --port 4096')` starts OpenCode
6. Control plane sends prompts to OpenCode via `sandbox.exec()` or HTTP through the sandbox

---

## Task 1: Replace @cloudflare/containers with @cloudflare/sandbox

**Files:**

- Modify: `packages/control-plane/package.json`

- [ ] **Step 1: Uninstall old, install new**

```bash
cd packages/control-plane
npm uninstall @cloudflare/containers
npm install @cloudflare/sandbox
```

- [ ] **Step 2: Verify installation**

```bash
ls node_modules/@cloudflare/sandbox/package.json && echo "OK"
```

- [ ] **Step 3: Commit**

```bash
git add packages/control-plane/package.json package-lock.json
git commit -m "chore: replace @cloudflare/containers with @cloudflare/sandbox"
```

---

## Task 2: Rewrite SandboxContainer → re-export Sandbox from SDK

**Files:**

- Rewrite: `packages/control-plane/src/containers/sandbox-container.ts`
- Rewrite: `packages/control-plane/src/containers/sandbox-container.test.ts`

The custom `SandboxContainer extends Container` class is replaced by re-exporting the SDK's
`Sandbox` class. The SDK handles all lifecycle (start, sleep, destroy) automatically.

- [ ] **Step 1: Rewrite sandbox-container.ts**

```typescript
// packages/control-plane/src/containers/sandbox-container.ts

// Re-export the Sandbox class from the SDK.
// Cloudflare Workers discovers this as a Durable Object export.
// The SDK's Sandbox extends Container and handles lifecycle automatically.
export { Sandbox as SandboxContainer } from "@cloudflare/sandbox";

// Also export getSandbox for use by the provider
export { getSandbox } from "@cloudflare/sandbox";
```

- [ ] **Step 2: Rewrite test**

```typescript
// packages/control-plane/src/containers/sandbox-container.test.ts
import { describe, it, expect } from "vitest";

// Mock the cloudflare:workers module (needed in Node test env)
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
}));

describe("SandboxContainer exports", () => {
  it("re-exports SandboxContainer from @cloudflare/sandbox", async () => {
    const mod = await import("./sandbox-container");
    expect(mod.SandboxContainer).toBeDefined();
  });

  it("re-exports getSandbox from @cloudflare/sandbox", async () => {
    const mod = await import("./sandbox-container");
    expect(mod.getSandbox).toBeDefined();
  });
});
```

- [ ] **Step 3: Run tests**

```bash
npm test -w @open-inspect/control-plane -- --run src/containers/sandbox-container.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add packages/control-plane/src/containers/
git commit -m "refactor: replace custom SandboxContainer with @cloudflare/sandbox re-export"
```

---

## Task 3: Rewrite CloudflareContainerProvider to use Sandbox SDK

**Files:**

- Rewrite: `packages/control-plane/src/sandbox/providers/container-provider.ts`
- Rewrite: `packages/control-plane/src/sandbox/providers/container-provider.test.ts`

Instead of calling a Container DO's `/configure` endpoint, the provider uses `getSandbox()` to get a
Sandbox instance, sets env vars, clones the repo, and starts OpenCode.

- [ ] **Step 1: Rewrite container-provider.ts**

```typescript
// packages/control-plane/src/sandbox/providers/container-provider.ts
import {
  SandboxProviderError,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type CreateSandboxConfig,
  type CreateSandboxResult,
} from "../provider";
import { getSandbox } from "../../containers/sandbox-container";

export interface ContainerSecrets {
  anthropicApiKey?: string;
  githubAppId?: string;
  githubAppPrivateKey?: string;
  githubAppInstallationId?: string;
}

export class CloudflareContainerProvider implements SandboxProvider {
  readonly name = "cloudflare-sandbox";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: false,
    supportsRestore: false,
    supportsWarm: false,
  };

  constructor(
    private readonly sandboxBinding: DurableObjectNamespace,
    private readonly secrets: ContainerSecrets
  ) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      // Get a sandbox instance keyed by sandbox ID (session affinity)
      const sandbox = getSandbox(this.sandboxBinding, config.sandboxId, {
        sleepAfter: "1h",
      });

      // Set environment variables for the sandbox
      const envVars: Record<string, string | undefined> = {
        ANTHROPIC_API_KEY: this.secrets.anthropicApiKey,
        GITHUB_APP_ID: this.secrets.githubAppId,
        GITHUB_APP_PRIVATE_KEY: this.secrets.githubAppPrivateKey,
        GITHUB_APP_INSTALLATION_ID: this.secrets.githubAppInstallationId,
        // Session config for the bridge (if we use it later)
        SANDBOX_ID: config.sandboxId,
        CONTROL_PLANE_URL: config.controlPlaneUrl,
        SANDBOX_AUTH_TOKEN: config.sandboxAuthToken,
        REPO_OWNER: config.repoOwner,
        REPO_NAME: config.repoName,
        SESSION_CONFIG: JSON.stringify({
          session_id: config.sessionId,
          provider: config.provider,
          model: config.model,
          branch: config.branch || "main",
        }),
      };

      // Merge user env vars (repo secrets)
      if (config.userEnvVars) {
        for (const [key, value] of Object.entries(config.userEnvVars)) {
          envVars[key] = value;
        }
      }

      await sandbox.setEnvVars(envVars);

      // Clone the repository
      const repoUrl = `https://github.com/${config.repoOwner}/${config.repoName}.git`;
      await sandbox.gitCheckout(repoUrl, {
        branch: config.branch,
        targetDir: `/workspace/${config.repoName}`,
        depth: 100,
      });

      // Run setup script if it exists
      await sandbox.exec(
        `cd /workspace/${config.repoName} && [ -f .openinspect/setup.sh ] && bash .openinspect/setup.sh || true`,
        { timeout: 300_000 } // 5 min timeout for setup
      );

      // Start OpenCode server as a background process
      const process = await sandbox.startProcess(
        `cd /workspace/${config.repoName} && opencode server --port 4096`,
        { cwd: `/workspace/${config.repoName}` }
      );

      // Wait for OpenCode to be ready
      await process.waitForPort(4096, { timeout: 30_000 });

      return {
        sandboxId: config.sandboxId,
        providerObjectId: config.sandboxId,
        status: "running",
        createdAt: Date.now(),
      };
    } catch (error) {
      if (error instanceof SandboxProviderError) {
        throw error;
      }
      throw SandboxProviderError.fromFetchError("Failed to create sandbox", error);
    }
  }
}

export function createContainerProvider(
  sandboxBinding: DurableObjectNamespace,
  secrets: ContainerSecrets
): CloudflareContainerProvider {
  return new CloudflareContainerProvider(sandboxBinding, secrets);
}
```

- [ ] **Step 2: Rewrite tests**

```typescript
// packages/control-plane/src/sandbox/providers/container-provider.test.ts
import { describe, it, expect, vi } from "vitest";
import { CloudflareContainerProvider } from "./container-provider";
import { SandboxProviderError } from "../provider";

// Mock @cloudflare/sandbox
vi.mock("../../containers/sandbox-container", () => ({
  getSandbox: vi.fn(),
}));

function createMockSandbox(
  overrides: Partial<{
    setEnvVars: () => Promise<void>;
    gitCheckout: () => Promise<any>;
    exec: () => Promise<any>;
    startProcess: () => Promise<any>;
  }> = {}
) {
  const mockProcess = {
    waitForPort: vi.fn().mockResolvedValue(undefined),
  };
  return {
    setEnvVars: vi.fn().mockResolvedValue(undefined),
    gitCheckout: vi.fn().mockResolvedValue({ success: true }),
    exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
    startProcess: vi.fn().mockResolvedValue(mockProcess),
    ...overrides,
  };
}

const testConfig = {
  sessionId: "test-session",
  sandboxId: "sandbox-123",
  repoOwner: "testowner",
  repoName: "testrepo",
  controlPlaneUrl: "https://control-plane.test",
  sandboxAuthToken: "auth-token",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
};

describe("CloudflareContainerProvider", () => {
  it("reports correct capabilities", () => {
    const binding = {} as DurableObjectNamespace;
    const provider = new CloudflareContainerProvider(binding, {});
    expect(provider.name).toBe("cloudflare-sandbox");
    expect(provider.capabilities.supportsSnapshots).toBe(false);
    expect(provider.capabilities.supportsRestore).toBe(false);
    expect(provider.capabilities.supportsWarm).toBe(false);
  });

  it("creates sandbox successfully", async () => {
    const { getSandbox } = await import("../../containers/sandbox-container");
    const mockSandbox = createMockSandbox();
    (getSandbox as ReturnType<typeof vi.fn>).mockReturnValue(mockSandbox);

    const binding = {} as DurableObjectNamespace;
    const provider = new CloudflareContainerProvider(binding, { anthropicApiKey: "sk-test" });

    const result = await provider.createSandbox(testConfig);

    expect(result.sandboxId).toBe("sandbox-123");
    expect(result.status).toBe("running");
    expect(mockSandbox.setEnvVars).toHaveBeenCalled();
    expect(mockSandbox.gitCheckout).toHaveBeenCalledWith(
      "https://github.com/testowner/testrepo.git",
      expect.objectContaining({ targetDir: "/workspace/testrepo" })
    );
    expect(mockSandbox.startProcess).toHaveBeenCalled();
  });

  it("wraps errors as SandboxProviderError", async () => {
    const { getSandbox } = await import("../../containers/sandbox-container");
    const mockSandbox = createMockSandbox({
      gitCheckout: vi.fn().mockRejectedValue(new Error("clone failed")),
    });
    (getSandbox as ReturnType<typeof vi.fn>).mockReturnValue(mockSandbox);

    const binding = {} as DurableObjectNamespace;
    const provider = new CloudflareContainerProvider(binding, {});

    await expect(provider.createSandbox(testConfig)).rejects.toThrow(SandboxProviderError);
  });
});
```

- [ ] **Step 3: Run tests**

```bash
npm test -w @open-inspect/control-plane -- --run src/sandbox/providers/container-provider.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add packages/control-plane/src/sandbox/providers/container-provider.ts \
       packages/control-plane/src/sandbox/providers/container-provider.test.ts
git commit -m "refactor: rewrite container provider to use @cloudflare/sandbox SDK"
```

---

## Task 4: Update index.ts export and Env type

**Files:**

- Modify: `packages/control-plane/src/index.ts`
- Modify: `packages/control-plane/src/types.ts`

- [ ] **Step 1: Update index.ts**

Change the SandboxContainer export to re-export from the sandbox SDK:

```typescript
// Replace:
export { SandboxContainer } from "./containers/sandbox-container";
// With:
export { SandboxContainer } from "./containers/sandbox-container";
```

This doesn't change since we aliased it in Task 2. But verify the export works.

- [ ] **Step 2: Update Env type if needed**

The binding name `SANDBOX_CONTAINER` stays the same in `types.ts`. The SDK's Sandbox class is a
DurableObject, so `DurableObjectNamespace` type is correct.

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck -w @open-inspect/control-plane
```

- [ ] **Step 4: Commit if any changes**

---

## Task 5: Update Dockerfile to use Cloudflare sandbox base image

**Files:**

- Rewrite: `Dockerfile.sandbox` (repo root)

- [ ] **Step 1: Rewrite Dockerfile**

```dockerfile
FROM docker.io/cloudflare/sandbox:0.7.18

# Additional system packages (beyond what sandbox base provides)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    openssh-client \
    jq \
    unzip \
    # Chromium shared libs for agent-browser
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libasound2 libpango-1.0-0 libcairo2 \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main' \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Node.js 22 LTS (sandbox base has Node 20, we need 22)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g pnpm@latest

# Bun runtime
RUN curl -fsSL https://bun.sh/install | bash

# Python tools (sandbox base has Python 3.11)
RUN pip3 install --break-system-packages uv

# OpenCode CLI
RUN npm install -g opencode-ai@latest @opencode-ai/plugin@latest zod

# code-server
RUN curl -fsSL -o /tmp/code-server.deb \
      https://github.com/coder/code-server/releases/download/v4.109.5/code-server_4.109.5_amd64.deb \
    && dpkg -i /tmp/code-server.deb && rm /tmp/code-server.deb

# agent-browser + Chromium
RUN npm install -g agent-browser@0.21.2 && agent-browser install

# Working directories
RUN mkdir -p /workspace /app/plugins /tmp/opencode

ENV HOME=/root \
    NODE_ENV=development \
    NODE_PATH=/usr/lib/node_modules

WORKDIR /workspace

EXPOSE 4096 8080
```

- [ ] **Step 2: Commit**

```bash
git add Dockerfile.sandbox
git commit -m "refactor: use cloudflare/sandbox base image for proper container networking"
```

---

## Task 6: Update wrangler configs and integration test stubs

**Files:**

- Modify: `packages/control-plane/wrangler.deploy.jsonc`
- Modify: `packages/control-plane/wrangler.jsonc`
- Modify: `packages/control-plane/shims/cloudflare-containers.js`
- Modify: `packages/control-plane/test/integration/stubs/cloudflare-containers.ts`
- Modify: `packages/control-plane/package.json` (esbuild external)

- [ ] **Step 1: Update deploy config**

In `wrangler.deploy.jsonc`, the container class_name must match our export name: `SandboxContainer`
(which is the re-exported Sandbox class).

- [ ] **Step 2: Update local dev shim**

Replace `shims/cloudflare-containers.js` with a shim for `@cloudflare/sandbox`:

```javascript
// Local dev shim for @cloudflare/sandbox
import { DurableObject } from "cloudflare:workers";

export class Sandbox extends DurableObject {}
export { Sandbox as SandboxContainer };
export function getSandbox() {
  throw new Error("Sandbox SDK not available in local dev");
}
```

- [ ] **Step 3: Update esbuild external**

In `package.json` build script, replace `--external:@cloudflare/containers` with
`--external:@cloudflare/sandbox`.

- [ ] **Step 4: Update integration test stub**

Replace the `@cloudflare/containers` stub with a `@cloudflare/sandbox` stub.

- [ ] **Step 5: Update wrangler alias**

In `wrangler.jsonc`, change the alias from `@cloudflare/containers` to `@cloudflare/sandbox`.

- [ ] **Step 6: Run build + tests**

```bash
npm run build -w @open-inspect/control-plane
npm test -w @open-inspect/control-plane
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: update configs for @cloudflare/sandbox SDK"
```

---

## Task 7: Deploy and test

- [ ] **Step 1: Deploy**

```bash
cd packages/control-plane
npx wrangler deploy -c wrangler.deploy.jsonc
```

- [ ] **Step 2: Verify health**

```bash
curl https://open-inspect-cp-jdunn.telus.workers.dev/health
```

- [ ] **Step 3: Test in browser**

Create new session, send prompt, verify sandbox reaches "running" state.
