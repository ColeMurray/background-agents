import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL, extractProviderAndModel } from "@open-inspect/shared/models";
import { createModalClient, type CreateSandboxRequest } from "./client";
import { encodeModalCreate, parseModalLaunchContractVersion } from "./modal-launch-contract";

afterEach(() => vi.restoreAllMocks());

describe("interactive launch producer contract", () => {
  it.each(["legacy", "1"] as const)("uses split catalog defaults for %s", (version) => {
    const encoded = encodeModalCreate(
      {
        sessionId: "session-contract",
        sandboxId: "sandbox-contract",
        repoOwner: null,
        repoName: null,
        harness: "opencode",
        controlPlaneUrl: "https://control.example.test",
        sandboxAuthToken: "synthetic-auth",
      },
      version
    );
    const config = "session_config" in encoded ? encoded.session_config : encoded;
    expect(config).toMatchObject(extractProviderAndModel(DEFAULT_MODEL));
    expect(config.model).not.toBe(DEFAULT_MODEL);
  });
  it("emits real client requests for the Python/runtime contract suite", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const emitted: unknown[] = [];
    let body: Record<string, unknown> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            sandbox_id: "sandbox-contract",
            modal_object_id: "provider-contract",
            created_at: 123,
          },
        }),
        { status: 200 }
      );
    });
    for (const version of ["legacy", "1"] as const) {
      for (const operation of ["create", "restore"] as const) {
        for (const shape of ["none", "scalar", "multi", "pinned"] as const) {
          const services = shape === "multi" || shape === "pinned";
          const request: CreateSandboxRequest = {
            sessionId: "session-contract",
            sandboxId: "sandbox-contract",
            controlPlaneUrl: "https://control.example.test",
            sandboxAuthToken: "synthetic-auth",
            repoOwner: shape === "none" ? null : "group/subgroup",
            repoName: shape === "none" ? null : "repo",
            branch: shape === "none" ? null : "feature/契約",
            harness: shape === "pinned" ? "claude" : "opencode",
            provider: "anthropic",
            model: "contract-model",
            userEnvVars: {
              CUSTOM_VALUE: 'quotes" and unicode 契約',
              SESSION_CONFIG: "untrusted",
              SANDBOX_AUTH_TOKEN: "untrusted",
              IMAGE_BUILD_MODE: "true",
              VNC_PASSWORD: "untrusted",
            },
            codeServerEnabled: services,
            vncEnabled: services,
            agentSlackNotifyEnabled: services,
            ...(services
              ? {
                  timeoutSeconds: 4321,
                  sandboxSettings: {
                    terminalEnabled: true,
                    codeServerPort: 9000,
                    vncPort: 9001,
                    terminalPort: 9002,
                    tunnelPorts: [3000],
                    cpuCores: 1.5,
                    memoryMib: 3072,
                  },
                  mcpServers: [
                    {
                      id: "contract-mcp",
                      name: "Contract",
                      type: "local",
                      enabled: true,
                      command: ["node", "server.js"],
                    },
                  ],
                }
              : {}),
            ...(shape === "multi" || shape === "pinned"
              ? {
                  repositories: [
                    {
                      repoOwner: "group/subgroup",
                      repoName: "repo",
                      baseBranch: "feature/契約",
                      baseSha: "a".repeat(40),
                    },
                    ...(shape === "multi"
                      ? [{ repoOwner: "group", repoName: "other", baseBranch: "develop" }]
                      : []),
                  ],
                }
              : {}),
            ...(shape === "scalar"
              ? { prebuiltImageId: "image-contract", prebuiltImageSha: "base123" }
              : {}),
          };
          const client = createModalClient(
            "synthetic-secret",
            "contract",
            undefined,
            undefined,
            version
          );
          if (operation === "create") await client.createSandbox(request);
          else
            await client.restoreSandbox({
              ...request,
              sandboxId: "sandbox-contract",
              provider: "anthropic",
              model: "contract-model",
              snapshotImageId: "snapshot-contract",
            });
          expect(body.sandbox_auth_token).toBe("synthetic-auth");
          expect(body.contract_version).toBe(version === "1" ? 1 : undefined);
          expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
            event: "modal.request",
            launch_contract_version: version,
            outcome: "success",
            session_id: request.sessionId,
            sandbox_id: request.sandboxId,
          });
          emitted.push({
            version,
            operation,
            shape,
            body,
            expected: {
              services,
              harness: request.harness,
              repoOwner: request.repoOwner,
              repoName: request.repoName,
              timeout: services ? 4321 : 7200,
            },
          });
        }
      }
    }
    expect(emitted).toHaveLength(16);
    // Only the explicit cross-language runner writes an artifact; it is synthetic
    // and lives in a temporary directory, never a production request capture.
    if (process.env.LAUNCH_CONTRACT_OUTPUT) {
      writeFileSync(process.env.LAUNCH_CONTRACT_OUTPUT, JSON.stringify(emitted));
    }
  });

  it("defaults to legacy and rejects invalid rollout configuration", () => {
    expect(parseModalLaunchContractVersion()).toBe("legacy");
    expect(parseModalLaunchContractVersion("1")).toBe("1");
    expect(() => parseModalLaunchContractVersion("2")).toThrow();
  });

  it("does not retry or downgrade after an ambiguous v1 response", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const client = createModalClient("synthetic-secret", "contract", undefined, undefined, "1");
    await expect(
      client.createSandbox({
        sessionId: "session-contract",
        sandboxId: "sandbox-contract",
        repoOwner: null,
        repoName: null,
        harness: "opencode",
        controlPlaneUrl: "https://control.example.test",
        sandboxAuthToken: "synthetic-auth",
      })
    ).rejects.toThrow("Invalid response");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
