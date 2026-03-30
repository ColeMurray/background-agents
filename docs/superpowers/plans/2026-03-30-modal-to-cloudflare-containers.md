# Modal to Cloudflare Containers Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** Replace the Modal data plane with Cloudflare Containers so the entire Open-Inspect stack
runs on Cloudflare. Remove Linear bot.

**Architecture:** New `CloudflareContainerProvider` implements the existing `SandboxProvider`
interface. A `SandboxContainer` class (extending Cloudflare `Container`) runs the same Python sandbox
runtime. Control plane talks to it via Durable Object stubs instead of HTTP calls to Modal.

**Tech Stack:** TypeScript (Cloudflare Workers, `@cloudflare/containers`), Docker, Terraform
(Cloudflare provider), Python (sandbox-runtime, unchanged)

---

## File Map

### Created

| File | Responsibility |
|---|---|
| `packages/control-plane/src/sandbox/providers/container-provider.ts` | `CloudflareContainerProvider` implementing `SandboxProvider` |
| `packages/control-plane/src/sandbox/providers/container-provider.test.ts` | Unit tests for container provider |
| `packages/control-plane/src/containers/sandbox-container.ts` | `SandboxContainer extends Container` class |
| `packages/control-plane/src/containers/sandbox-container.test.ts` | Unit tests for container class |
| `packages/control-plane/Dockerfile.sandbox` | Container image (mirrors Modal base.py) |

### Modified

| File | Change |
|---|---|
| `packages/control-plane/src/types.ts` | Replace Modal env vars with `SANDBOX_CONTAINER` binding |
| `packages/control-plane/src/session/durable-object.ts:16-17,530-538` | Replace Modal imports + provider creation |
| `packages/control-plane/src/index.ts:14-15` | Add `SandboxContainer` export |
| `packages/control-plane/wrangler.jsonc` | Add container config + binding |
| `packages/control-plane/package.json` | Add `@cloudflare/containers` dependency |
| `terraform/environments/production/workers-control-plane.tf:57-77,79-82` | Replace Modal bindings with container config |
| `terraform/environments/production/variables.tf:40-55,153-193,227-231` | Remove Modal + Linear vars, add sandbox vars |
| `terraform/environments/production/outputs.tf` | Remove Modal outputs |

### Deleted

| File | Reason |
|---|---|
| `packages/control-plane/src/sandbox/client.ts` | Modal HTTP API client |
| `packages/control-plane/src/sandbox/providers/modal-provider.ts` | Modal provider |
| `packages/control-plane/src/sandbox/providers/modal-provider.test.ts` | Modal provider tests |
| `packages/modal-infra/` | Entire Modal data plane package |
| `packages/linear-bot/` | Not needed |
| `terraform/environments/production/modal.tf` | Modal Terraform resources |
| `terraform/environments/production/workers-linear-bot.tf` | Linear bot worker |

---

## Task 1: Add `@cloudflare/containers` dependency

**Files:**
- Modify: `packages/control-plane/package.json`

- [ ] **Step 1: Install the dependency**

```bash
cd packages/control-plane
npm install @cloudflare/containers
```

- [ ] **Step 2: Verify it installed**

```bash
cat packages/control-plane/package.json | grep containers
```

Expected: `"@cloudflare/containers": "^x.x.x"` in dependencies.

- [ ] **Step 3: Commit**

```bash
git add packages/control-plane/package.json package-lock.json
git commit -m "chore: add @cloudflare/containers dependency"
```

---

## Task 2: Create `SandboxContainer` class

**Files:**
- Create: `packages/control-plane/src/containers/sandbox-container.ts`
- Test: `packages/control-plane/src/containers/sandbox-container.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// packages/control-plane/src/containers/sandbox-container.test.ts
import { describe, it, expect } from "vitest";

describe("SandboxContainer", () => {
  // SandboxContainer extends Container which requires workerd runtime.
  // We test the configuration constants and types here; integration tests
  // cover the full lifecycle.

  it("exports SANDBOX_DEFAULT_PORT", async () => {
    const { SANDBOX_DEFAULT_PORT } = await import("./sandbox-container");
    expect(SANDBOX_DEFAULT_PORT).toBe(4096);
  });

  it("exports SANDBOX_CODE_SERVER_PORT", async () => {
    const { SANDBOX_CODE_SERVER_PORT } = await import("./sandbox-container");
    expect(SANDBOX_CODE_SERVER_PORT).toBe(8080);
  });

  it("exports SANDBOX_SLEEP_AFTER", async () => {
    const { SANDBOX_SLEEP_AFTER } = await import("./sandbox-container");
    expect(SANDBOX_SLEEP_AFTER).toBe("60m");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -w @open-inspect/control-plane -- --run src/containers/sandbox-container.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/control-plane/src/containers/sandbox-container.ts
import { Container } from "@cloudflare/containers";

/** Port the OpenCode server listens on inside the container. */
export const SANDBOX_DEFAULT_PORT = 4096;

/** Port code-server listens on inside the container. */
export const SANDBOX_CODE_SERVER_PORT = 8080;

/** Inactivity timeout before the container sleeps. */
export const SANDBOX_SLEEP_AFTER = "60m";

/**
 * Session configuration stored in DO storage before starting the container.
 * Read back by fetch("/configure") and passed as envVars to startAndWaitForPorts().
 */
export interface SandboxSessionConfig {
  sandboxId: string;
  sessionId: string;
  controlPlaneUrl: string;
  sandboxAuthToken: string;
  repoOwner: string;
  repoName: string;
  provider: string;
  model: string;
  branch?: string;
  userEnvVars?: Record<string, string>;
  codeServerEnabled?: boolean;
  anthropicApiKey?: string;
  githubAppId?: string;
  githubAppPrivateKey?: string;
  githubAppInstallationId?: string;
}

/**
 * Cloudflare Container wrapping the sandbox runtime.
 *
 * Each instance is a Durable Object addressed by session/sandbox ID.
 * The Python sandbox_runtime.entrypoint runs inside the container and
 * connects back to the control plane via outbound WebSocket.
 */
export class SandboxContainer extends Container {
  defaultPort = SANDBOX_DEFAULT_PORT;
  sleepAfter = SANDBOX_SLEEP_AFTER;
  enableInternet = true;
  pingEndpoint = "/health";

  private sessionConfig: SandboxSessionConfig | null = null;

  /**
   * Handle requests from the control plane.
   *
   * Routes:
   * - POST /configure — store session config, start container
   * - GET /status — return container state
   * - POST /destroy — stop the container
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/configure") {
      return this.handleConfigure(request);
    }

    if (request.method === "GET" && url.pathname === "/status") {
      return this.handleStatus();
    }

    if (request.method === "POST" && url.pathname === "/destroy") {
      return this.handleDestroy();
    }

    // Forward all other requests to the container process
    return super.fetch(request);
  }

  /**
   * Called when sleepAfter timer fires.
   * Return true to keep alive, false to allow sleep.
   */
  override onActivityExpired(): boolean | Promise<boolean> {
    // Let the container sleep. The control plane's inactivity timeout
    // handles this via alarms — we don't need to duplicate logic here.
    return false;
  }

  override async onStart(): Promise<void> {
    // Restore config from DO storage on restart (e.g., after a deploy)
    const stored = await this.ctx.storage.get<SandboxSessionConfig>("sessionConfig");
    if (stored) {
      this.sessionConfig = stored;
    }
  }

  override async onStop(): Promise<void> {
    // Cleanup: remove config from memory (DO storage persists independently)
    this.sessionConfig = null;
  }

  override onError(error: unknown): void {
    console.error("SandboxContainer error:", error);
  }

  private async handleConfigure(request: Request): Promise<Response> {
    const config = (await request.json()) as SandboxSessionConfig;
    this.sessionConfig = config;

    // Persist config in DO storage so it survives deploys
    await this.ctx.storage.put("sessionConfig", config);

    // Build environment variables for the container process
    const envVars: Record<string, string> = {
      SANDBOX_ID: config.sandboxId,
      SESSION_ID: config.sessionId,
      CONTROL_PLANE_URL: config.controlPlaneUrl,
      SANDBOX_AUTH_TOKEN: config.sandboxAuthToken,
      REPO_OWNER: config.repoOwner,
      REPO_NAME: config.repoName,
      VCS_HOST: "github.com",
      VCS_CLONE_USERNAME: "x-access-token",
      PROVIDER: config.provider,
      MODEL: config.model,
      PYTHONUNBUFFERED: "1",
      HOME: "/root",
      NODE_ENV: "development",
      NODE_PATH: "/usr/lib/node_modules",
    };

    if (config.branch) {
      envVars.BRANCH = config.branch;
    }
    if (config.anthropicApiKey) {
      envVars.ANTHROPIC_API_KEY = config.anthropicApiKey;
    }
    if (config.githubAppId) {
      envVars.GITHUB_APP_ID = config.githubAppId;
    }
    if (config.githubAppPrivateKey) {
      envVars.GITHUB_APP_PRIVATE_KEY = config.githubAppPrivateKey;
    }
    if (config.githubAppInstallationId) {
      envVars.GITHUB_APP_INSTALLATION_ID = config.githubAppInstallationId;
    }
    if (config.codeServerEnabled) {
      envVars.CODE_SERVER_ENABLED = "true";
    }

    // Merge user-provided env vars (repo secrets)
    if (config.userEnvVars) {
      for (const [key, value] of Object.entries(config.userEnvVars)) {
        envVars[key] = value;
      }
    }

    // Build required ports list
    const ports = config.codeServerEnabled
      ? [SANDBOX_DEFAULT_PORT, SANDBOX_CODE_SERVER_PORT]
      : [SANDBOX_DEFAULT_PORT];

    // Start the container with per-instance env vars
    await this.startAndWaitForPorts({
      ports,
      startOptions: { envVars },
    });

    return Response.json({ success: true, sandboxId: config.sandboxId });
  }

  private handleStatus(): Response {
    const running = this.ctx.container.running;
    return Response.json({
      running,
      sandboxId: this.sessionConfig?.sandboxId ?? null,
    });
  }

  private async handleDestroy(): Promise<Response> {
    try {
      this.ctx.container.destroy();
    } catch {
      // Container may already be stopped
    }
    return Response.json({ success: true });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test -w @open-inspect/control-plane -- --run src/containers/sandbox-container.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/control-plane/src/containers/
git commit -m "feat: add SandboxContainer class for Cloudflare Containers"
```

---

## Task 3: Create `CloudflareContainerProvider`

**Files:**
- Create: `packages/control-plane/src/sandbox/providers/container-provider.ts`
- Test: `packages/control-plane/src/sandbox/providers/container-provider.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// packages/control-plane/src/sandbox/providers/container-provider.test.ts
import { describe, it, expect, vi } from "vitest";
import { CloudflareContainerProvider } from "./container-provider";
import { SandboxProviderError } from "../provider";

// Minimal mock of the DurableObjectNamespace + stub chain
function createMockContainerBinding(overrides: {
  fetchResponse?: Response;
  fetchError?: Error;
} = {}) {
  const fetchFn = overrides.fetchError
    ? vi.fn().mockRejectedValue(overrides.fetchError)
    : vi.fn().mockResolvedValue(
        overrides.fetchResponse ??
          new Response(JSON.stringify({ success: true, sandboxId: "sandbox-123" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
      );

  const stub = { fetch: fetchFn };

  return {
    idFromName: vi.fn().mockReturnValue("mock-do-id"),
    get: vi.fn().mockReturnValue(stub),
    _stub: stub,
    _fetchFn: fetchFn,
  } as unknown as DurableObjectNamespace;
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
  describe("capabilities", () => {
    it("reports correct capabilities", () => {
      const binding = createMockContainerBinding();
      const provider = new CloudflareContainerProvider(binding, {});
      expect(provider.name).toBe("cloudflare-container");
      expect(provider.capabilities.supportsSnapshots).toBe(false);
      expect(provider.capabilities.supportsRestore).toBe(false);
      expect(provider.capabilities.supportsWarm).toBe(false);
    });
  });

  describe("createSandbox", () => {
    it("creates sandbox successfully", async () => {
      const binding = createMockContainerBinding();
      const provider = new CloudflareContainerProvider(binding, {});

      const result = await provider.createSandbox(testConfig);

      expect(result.sandboxId).toBe("sandbox-123");
      expect(result.status).toBe("warming");
      expect(result.createdAt).toBeGreaterThan(0);
    });

    it("passes sandbox ID to getByName for session affinity", async () => {
      const binding = createMockContainerBinding();
      const provider = new CloudflareContainerProvider(binding, {});

      await provider.createSandbox(testConfig);

      expect(binding.idFromName).toHaveBeenCalledWith("sandbox-123");
    });

    it("classifies network errors as transient", async () => {
      const binding = createMockContainerBinding({
        fetchError: new Error("fetch failed: connection refused"),
      });
      const provider = new CloudflareContainerProvider(binding, {});

      await expect(provider.createSandbox(testConfig)).rejects.toThrow(SandboxProviderError);

      try {
        await provider.createSandbox(testConfig);
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("transient");
      }
    });

    it("classifies HTTP 500 as permanent", async () => {
      const binding = createMockContainerBinding({
        fetchResponse: new Response("Internal Server Error", { status: 500 }),
      });
      const provider = new CloudflareContainerProvider(binding, {});

      await expect(provider.createSandbox(testConfig)).rejects.toThrow(SandboxProviderError);

      try {
        await provider.createSandbox(testConfig);
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("permanent");
      }
    });

    it("classifies HTTP 503 as transient", async () => {
      const binding = createMockContainerBinding({
        fetchResponse: new Response("Service Unavailable", { status: 503 }),
      });
      const provider = new CloudflareContainerProvider(binding, {});

      try {
        await provider.createSandbox(testConfig);
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("transient");
      }
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -w @open-inspect/control-plane -- --run src/sandbox/providers/container-provider.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/control-plane/src/sandbox/providers/container-provider.ts
import {
  SandboxProviderError,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type CreateSandboxConfig,
  type CreateSandboxResult,
} from "../provider";
import type { SandboxSessionConfig } from "../../containers/sandbox-container";

/**
 * Secrets passed from the control plane env to the container at startup.
 * These are NOT part of CreateSandboxConfig — they come from the Worker's env bindings.
 */
export interface ContainerSecrets {
  anthropicApiKey?: string;
  githubAppId?: string;
  githubAppPrivateKey?: string;
  githubAppInstallationId?: string;
}

/**
 * Cloudflare Container sandbox provider.
 *
 * Creates sandboxes by getting a Durable Object stub for the SandboxContainer
 * class and calling its /configure endpoint with session config.
 */
export class CloudflareContainerProvider implements SandboxProvider {
  readonly name = "cloudflare-container";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: false,
    supportsRestore: false,
    supportsWarm: false,
  };

  constructor(
    private readonly containerBinding: DurableObjectNamespace,
    private readonly secrets: ContainerSecrets
  ) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      // Get a container stub addressed by sandbox ID (session affinity)
      const doId = this.containerBinding.idFromName(config.sandboxId);
      const stub = this.containerBinding.get(doId);

      // Build the session config for the container
      const sessionConfig: SandboxSessionConfig = {
        sandboxId: config.sandboxId,
        sessionId: config.sessionId,
        controlPlaneUrl: config.controlPlaneUrl,
        sandboxAuthToken: config.sandboxAuthToken,
        repoOwner: config.repoOwner,
        repoName: config.repoName,
        provider: config.provider,
        model: config.model,
        branch: config.branch,
        userEnvVars: config.userEnvVars,
        codeServerEnabled: config.codeServerEnabled,
        anthropicApiKey: this.secrets.anthropicApiKey,
        githubAppId: this.secrets.githubAppId,
        githubAppPrivateKey: this.secrets.githubAppPrivateKey,
        githubAppInstallationId: this.secrets.githubAppInstallationId,
      };

      // Call the container's /configure endpoint to store config and start
      const response = await stub.fetch("http://container/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sessionConfig),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw SandboxProviderError.fromFetchError(
          `Container configure failed: ${errorText}`,
          new Error(errorText),
          response.status
        );
      }

      return {
        sandboxId: config.sandboxId,
        providerObjectId: config.sandboxId, // Container DO is addressed by sandbox ID
        status: "warming",
        createdAt: Date.now(),
      };
    } catch (error) {
      if (error instanceof SandboxProviderError) {
        throw error;
      }
      throw SandboxProviderError.fromFetchError(
        "Failed to create container sandbox",
        error
      );
    }
  }
}

/**
 * Factory function to create a CloudflareContainerProvider.
 */
export function createContainerProvider(
  containerBinding: DurableObjectNamespace,
  secrets: ContainerSecrets
): CloudflareContainerProvider {
  return new CloudflareContainerProvider(containerBinding, secrets);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test -w @open-inspect/control-plane -- --run src/sandbox/providers/container-provider.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/control-plane/src/sandbox/providers/container-provider.ts \
       packages/control-plane/src/sandbox/providers/container-provider.test.ts
git commit -m "feat: add CloudflareContainerProvider implementing SandboxProvider"
```

---

## Task 4: Update `Env` type and wire the new provider

**Files:**
- Modify: `packages/control-plane/src/types.ts:35-85`
- Modify: `packages/control-plane/src/session/durable-object.ts:16-17,530-538`
- Modify: `packages/control-plane/src/index.ts:14-15`

- [ ] **Step 1: Update the Env type**

In `packages/control-plane/src/types.ts`, replace Modal bindings with the container binding:

Replace:
```typescript
  MODAL_TOKEN_ID?: string;
  MODAL_TOKEN_SECRET?: string;
  MODAL_API_SECRET?: string; // Shared secret for authenticating with Modal endpoints
```

With:
```typescript
  // Cloudflare Container binding for sandboxes
  SANDBOX_CONTAINER?: DurableObjectNamespace;
```

Also remove `MODAL_WORKSPACE` from the Variables section:
```typescript
  MODAL_WORKSPACE?: string; // Modal workspace name (used in Modal endpoint URLs)
```

And remove the `LINEAR_BOT` service binding:
```typescript
  LINEAR_BOT?: Fetcher; // Optional - only if linear-bot is deployed
```

- [ ] **Step 2: Update the SessionDO to use the container provider**

In `packages/control-plane/src/session/durable-object.ts`:

Replace lines 16-17 (imports):
```typescript
import { createModalClient } from "../sandbox/client";
import { createModalProvider } from "../sandbox/providers/modal-provider";
```

With:
```typescript
import { createContainerProvider } from "../sandbox/providers/container-provider";
```

Replace lines 530-538 (`createLifecycleManager` method start):
```typescript
  private createLifecycleManager(): SandboxLifecycleManager {
    // Verify Modal configuration
    if (!this.env.MODAL_API_SECRET || !this.env.MODAL_WORKSPACE) {
      throw new Error("MODAL_API_SECRET and MODAL_WORKSPACE are required for lifecycle manager");
    }

    // Create Modal provider
    const modalClient = createModalClient(this.env.MODAL_API_SECRET, this.env.MODAL_WORKSPACE);
    const provider = createModalProvider(modalClient);
```

With:
```typescript
  private createLifecycleManager(): SandboxLifecycleManager {
    // Verify container binding is available
    if (!this.env.SANDBOX_CONTAINER) {
      throw new Error("SANDBOX_CONTAINER binding is required for lifecycle manager");
    }

    // Create Cloudflare Container provider
    const provider = createContainerProvider(this.env.SANDBOX_CONTAINER, {
      anthropicApiKey: this.env.ANTHROPIC_API_KEY,
      githubAppId: this.env.GITHUB_APP_ID,
      githubAppPrivateKey: this.env.GITHUB_APP_PRIVATE_KEY,
      githubAppInstallationId: this.env.GITHUB_APP_INSTALLATION_ID,
    });
```

Also add `ANTHROPIC_API_KEY` to the Env type in `types.ts` (Secrets section):
```typescript
  ANTHROPIC_API_KEY?: string;
```

- [ ] **Step 3: Export SandboxContainer from the worker entry point**

In `packages/control-plane/src/index.ts`, add the export after line 15:

```typescript
export { SandboxContainer } from "./containers/sandbox-container";
```

So lines 13-16 become:
```typescript
// Re-export Durable Objects for Cloudflare to discover
export { SessionDO } from "./session/durable-object";
export { SchedulerDO } from "./scheduler/durable-object";
export { SandboxContainer } from "./containers/sandbox-container";
```

- [ ] **Step 4: Run typecheck to verify no type errors**

```bash
npm run typecheck -w @open-inspect/control-plane
```

Expected: No errors. (Modal client imports are still present in the codebase as dead files — they
won't cause type errors since nothing imports them after this change.)

- [ ] **Step 5: Run unit tests**

```bash
npm test -w @open-inspect/control-plane
```

Expected: Modal provider tests will fail (import path broken). That's expected — we delete them in
Task 5.

- [ ] **Step 6: Commit**

```bash
git add packages/control-plane/src/types.ts \
       packages/control-plane/src/session/durable-object.ts \
       packages/control-plane/src/index.ts
git commit -m "feat: wire CloudflareContainerProvider into session DO"
```

---

## Task 5: Delete Modal provider, client, and tests

**Files:**
- Delete: `packages/control-plane/src/sandbox/client.ts`
- Delete: `packages/control-plane/src/sandbox/providers/modal-provider.ts`
- Delete: `packages/control-plane/src/sandbox/providers/modal-provider.test.ts`

- [ ] **Step 1: Delete the files**

```bash
rm packages/control-plane/src/sandbox/client.ts
rm packages/control-plane/src/sandbox/providers/modal-provider.ts
rm packages/control-plane/src/sandbox/providers/modal-provider.test.ts
```

- [ ] **Step 2: Check for remaining imports of deleted modules**

```bash
cd /Users/t817787/Dev/experiments/background-agents-poc
grep -r "modal-provider\|modal\.client\|from.*sandbox/client\|ModalClient\|ModalProvider\|createModalClient\|createModalProvider\|ModalApiError" packages/control-plane/src/ --include="*.ts" -l
```

Expected: No results. If any files still import these, update them.

- [ ] **Step 3: Run all unit tests**

```bash
npm test -w @open-inspect/control-plane
```

Expected: All tests pass. The lifecycle manager tests mock the provider — they should still work
since they test against the `SandboxProvider` interface, not the Modal implementation.

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck -w @open-inspect/control-plane
```

Expected: Clean.

- [ ] **Step 5: Commit**

```bash
git add -u packages/control-plane/src/sandbox/
git commit -m "refactor: remove Modal provider, client, and tests"
```

---

## Task 6: Create the Dockerfile

**Files:**
- Create: `packages/control-plane/Dockerfile.sandbox`

- [ ] **Step 1: Write the Dockerfile**

Translate `packages/modal-infra/src/images/base.py` to a standard Dockerfile. Pin the same tool
versions.

```dockerfile
# packages/control-plane/Dockerfile.sandbox
#
# Sandbox runtime image for Open-Inspect Cloudflare Containers.
# Mirrors the Modal base image (packages/modal-infra/src/images/base.py).

FROM debian:bookworm-slim

# System packages (includes Chromium shared libs)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl build-essential ca-certificates gnupg openssh-client jq unzip \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libasound2 libpango-1.0-0 libcairo2 \
    python3.12 python3.12-venv python3-pip \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Node.js 22 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g pnpm@latest

# Bun runtime
RUN curl -fsSL https://bun.sh/install | bash
ENV BUN_INSTALL="/root/.bun"

# Python tools
RUN pip install --break-system-packages uv httpx websockets "pydantic>=2.0" "PyJWT[crypto]"

# OpenCode CLI + plugin
RUN npm install -g opencode-ai@latest @opencode-ai/plugin@latest zod

# code-server (browser-based VS Code)
RUN curl -fsSL -o /tmp/code-server.deb \
      https://github.com/coder/code-server/releases/download/v4.109.5/code-server_4.109.5_amd64.deb \
    && dpkg -i /tmp/code-server.deb && rm /tmp/code-server.deb

# agent-browser + Chromium
RUN npm install -g agent-browser@0.21.2 && agent-browser install

# Working directories
RUN mkdir -p /workspace /app/plugins /tmp/opencode

# Sandbox runtime code
COPY packages/sandbox-runtime/ /app/sandbox_runtime_pkg/
RUN cd /app/sandbox_runtime_pkg && pip install --break-system-packages -e .

# Environment
ENV HOME=/root \
    NODE_ENV=development \
    PNPM_HOME=/root/.local/share/pnpm \
    PATH="/root/.bun/bin:/root/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin" \
    PYTHONPATH=/app \
    NODE_PATH=/usr/lib/node_modules

WORKDIR /workspace

CMD ["python3", "-m", "sandbox_runtime.entrypoint"]
```

- [ ] **Step 2: Verify the Dockerfile is syntactically valid**

```bash
docker build --check -f packages/control-plane/Dockerfile.sandbox .
```

If `--check` is not available, just verify the file exists and is well-formed:
```bash
head -5 packages/control-plane/Dockerfile.sandbox
```

- [ ] **Step 3: Commit**

```bash
git add packages/control-plane/Dockerfile.sandbox
git commit -m "feat: add Dockerfile.sandbox mirroring Modal base image"
```

---

## Task 7: Update wrangler.jsonc with container config

**Files:**
- Modify: `packages/control-plane/wrangler.jsonc`

- [ ] **Step 1: Update wrangler.jsonc**

Replace the current content with:

```jsonc
// wrangler.jsonc — local dev config (Terraform manages production)
{
  "name": "open-inspect-control-plane",
  "main": "src/index.ts",
  "compatibility_date": "2026-01-10",
  "compatibility_flags": ["nodejs_compat"],

  "containers": [
    {
      "class_name": "SandboxContainer",
      "image": "./Dockerfile.sandbox",
      "instance_type": "standard-3",
      "max_instances": 10
    }
  ],

  "durable_objects": {
    "bindings": [
      { "name": "SESSION", "class_name": "SessionDO" },
      { "name": "SCHEDULER", "class_name": "SchedulerDO" },
      { "name": "SANDBOX_CONTAINER", "class_name": "SandboxContainer" }
    ]
  },

  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["SessionDO", "SchedulerDO"]
    },
    {
      "tag": "v2",
      "new_sqlite_classes": ["SandboxContainer"]
    }
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/control-plane/wrangler.jsonc
git commit -m "chore: add SandboxContainer to wrangler.jsonc"
```

---

## Task 8: Update Terraform — remove Modal, add Container config

**Files:**
- Delete: `terraform/environments/production/modal.tf`
- Delete: `terraform/environments/production/workers-linear-bot.tf`
- Modify: `terraform/environments/production/workers-control-plane.tf`
- Modify: `terraform/environments/production/variables.tf`
- Modify: `terraform/environments/production/outputs.tf`

- [ ] **Step 1: Delete Modal and Linear Terraform files**

```bash
rm terraform/environments/production/modal.tf
# Check if linear bot TF file exists before deleting
ls terraform/environments/production/workers-linear-bot.tf && \
  rm terraform/environments/production/workers-linear-bot.tf || echo "No linear bot TF file"
```

- [ ] **Step 2: Update workers-control-plane.tf**

In `terraform/environments/production/workers-control-plane.tf`, make these changes:

Remove from `plain_text_bindings` (line 61):
```hcl
    { name = "MODAL_WORKSPACE", value = var.modal_workspace },
```

Replace lines 69-71 in `secrets`:
```hcl
    { name = "MODAL_TOKEN_ID", value = var.modal_token_id },
    { name = "MODAL_TOKEN_SECRET", value = var.modal_token_secret },
    { name = "MODAL_API_SECRET", value = var.modal_api_secret },
```

With:
```hcl
    { name = "ANTHROPIC_API_KEY", value = var.anthropic_api_key },
```

Remove the `LINEAR_BOT` from `service_bindings` (lines 47-52):
```hcl
    var.enable_linear_bot ? [
      {
        binding_name = "LINEAR_BOT"
        service_name = "open-inspect-linear-bot-${local.name_suffix}"
      }
    ] : []
```

Add `SANDBOX_CONTAINER` to `durable_objects` (after line 81):
```hcl
    { binding_name = "SANDBOX_CONTAINER", class_name = "SandboxContainer" },
```

Remove `module.linear_bot_worker` from `depends_on` (line 94).

**Note:** The Container image/class config in Terraform depends on whether the `cloudflare-worker`
module supports `containers` blocks. If not, this may need a separate Terraform resource or a module
update. Check the Cloudflare Terraform provider docs for `cloudflare_worker_version` container
support. If not yet available, the container config is handled via wrangler only and Terraform
manages the rest.

- [ ] **Step 3: Update variables.tf**

Remove these variable blocks:
- `modal_token_id` (lines 40-44)
- `modal_token_secret` (lines 46-50)
- `modal_workspace` (lines 52-55)
- `modal_api_secret` (lines 227-231)
- `enable_linear_bot` (lines 153-166)
- `linear_client_id` (lines 168-171)
- `linear_client_secret` (lines 173-179)
- `linear_webhook_secret` (lines 181-186)
- `linear_api_key` (lines 188-193)

Add new variables:
```hcl
# =============================================================================
# Sandbox Container Configuration
# =============================================================================

variable "sandbox_instance_type" {
  description = "Cloudflare Container instance type for sandboxes (e.g., standard-2, standard-3, standard-4)"
  type        = string
  default     = "standard-3"
}

variable "sandbox_max_instances" {
  description = "Maximum number of concurrent sandbox containers"
  type        = number
  default     = 20
}
```

- [ ] **Step 4: Update outputs.tf**

Remove Modal-related outputs (modal_app_name, modal_health_url). These will be at the end of the
file — search for "modal" and remove those output blocks.

- [ ] **Step 5: Run terraform validate**

```bash
cd terraform/environments/production
terraform validate
```

Expected: Success (or warnings about missing backend config, which is fine for validation).

- [ ] **Step 6: Commit**

```bash
git add -u terraform/environments/production/
git add terraform/environments/production/
git commit -m "refactor: remove Modal + Linear from Terraform, add container config"
```

---

## Task 9: Delete Modal and Linear packages

**Files:**
- Delete: `packages/modal-infra/` (entire directory)
- Delete: `packages/linear-bot/` (entire directory)

- [ ] **Step 1: Delete the packages**

```bash
rm -rf packages/modal-infra
rm -rf packages/linear-bot
```

- [ ] **Step 2: Remove from workspace config**

Check the root `package.json` — it uses `"workspaces": ["packages/*"]` which is a glob, so removing
the directories is sufficient. No change needed to `package.json`.

- [ ] **Step 3: Run npm install to update lockfile**

```bash
npm install
```

- [ ] **Step 4: Run full lint and typecheck**

```bash
npm run lint
npm run typecheck
```

Expected: Clean. Any remaining references to Modal or Linear in other packages should surface here.

- [ ] **Step 5: Run all tests**

```bash
npm test
```

Expected: All passing. Modal-infra tests are gone. Linear-bot tests are gone. Control-plane tests
should pass with the new container provider.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove modal-infra and linear-bot packages"
```

---

## Task 10: End-to-end verification

- [ ] **Step 1: Build the full project**

```bash
npm run build
```

Expected: All packages build successfully.

- [ ] **Step 2: Run all unit tests across the monorepo**

```bash
npm test
```

Expected: All passing.

- [ ] **Step 3: Run control-plane integration tests**

```bash
npm run test:integration -w @open-inspect/control-plane
```

Expected: Integration tests may need updates if they reference Modal bindings in the test env. Check
for failures and fix any that reference `MODAL_API_SECRET` or `MODAL_WORKSPACE` — replace with
`SANDBOX_CONTAINER` binding in the test config.

- [ ] **Step 4: Run lint**

```bash
npm run lint
npm run format:check
```

Expected: Clean.

- [ ] **Step 5: Verify no Modal/Linear references remain**

```bash
grep -r "modal" packages/ --include="*.ts" --include="*.json" -l | grep -v node_modules | grep -v dist
grep -r "linear-bot\|linear_bot\|LINEAR_BOT" packages/ --include="*.ts" --include="*.json" -l | grep -v node_modules | grep -v dist
```

Expected: No results (or only harmless references like comments/docs).

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve remaining Modal/Linear references"
```
