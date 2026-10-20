import { Hono } from "hono";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { json, NO_AUTHORIZATION, type RequestContext } from "./shared";
import type { Env } from "../types";
import {
  createPiDeploymentCapabilitySnapshot,
  currentSandboxExecutionCapability,
} from "../pi/deployment-capabilities";
import {
  HARNESS_IDS,
  OPEN_INSPECT_RUNTIME_VERSIONS,
  type DeploymentCapabilities,
} from "@open-inspect/shared";

async function handleHealth(
  _request: Request,
  _env: Env,
  _params: object,
  _ctx: RequestContext
): Promise<Response> {
  return json({ status: "healthy", service: "open-inspect-control-plane" });
}

export const healthRoutes = new Hono<ControlPlaneHonoEnv>();

export function deploymentCapabilities(env: Env): DeploymentCapabilities {
  const modes = createPiDeploymentCapabilitySnapshot(env).capabilities;
  const bindingReachable = env.PI_SESSION !== undefined;
  const piEnabled = /^(?:true|1)$/i.test(env.PI_DURABLE_ENABLED?.trim() ?? "") && bindingReachable;
  return {
    version: 1,
    harnesses: HARNESS_IDS.map((id) => ({
      id,
      available: id !== "pi" || piEnabled,
      executionBackend: id === "pi" ? "durable_object" : "sandbox",
      modelProviders: id === "pi" ? ["openai"] : ["catalog"],
      authModes: id === "pi" ? ["provider_account"] : ["configured"],
    })),
    pi: {
      enabled: piEnabled,
      bindingReachable,
      modes,
      canary: {
        codeModeReady: modes.codeMode === "enabled",
        workspacePreviewAcknowledged:
          modes.workspace !== "off" || modes.repositoryEditing !== "off",
        mcpReady:
          modes.mcp !== "off" &&
          env.MCP_CONNECTIONS_ENABLED === "true" &&
          env.MCP_CONNECTION !== undefined,
        sandboxExecution: currentSandboxExecutionCapability(env),
      },
    },
    runtimeVersions: OPEN_INSPECT_RUNTIME_VERSIONS,
  };
}

healthRoutes.get(
  "/health",
  admit({
    authentication: { kind: "public" },
    supportedScmProviders: "all",
    authorization: NO_AUTHORIZATION,
  }),
  (c) => dispatch(c, handleHealth)
);

healthRoutes.get(
  "/capabilities",
  admit({
    authentication: { kind: "public" },
    supportedScmProviders: "all",
    authorization: NO_AUTHORIZATION,
  }),
  (c) => dispatch(c, (_request, env) => Promise.resolve(json(deploymentCapabilities(env))))
);
