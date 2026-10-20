import { z } from "zod";
import { harnessIdSchema } from "./harnesses";
import { piFeatureCapabilityMatrixSchema } from "./pi-feature-capabilities";

export const OPEN_INSPECT_RUNTIME_VERSIONS = Object.freeze({
  piDurable: "1.3.0",
  piHarness: "0.28.1",
  computer: "0.5.1",
  codeMode: "1.3.0",
  mcp: "2.3.1",
  wrangler: "4.103.0",
});

export const deploymentCapabilitiesSchema = z.object({
  version: z.literal(1),
  harnesses: z.array(
    z.object({
      id: harnessIdSchema,
      available: z.boolean(),
      executionBackend: z.enum(["sandbox", "durable_object"]),
      modelProviders: z.array(z.string().min(1)),
      authModes: z.array(z.string().min(1)),
    })
  ),
  pi: z.object({
    enabled: z.boolean(),
    bindingReachable: z.boolean(),
    modes: piFeatureCapabilityMatrixSchema,
    canary: z.object({
      codeModeReady: z.boolean(),
      workspacePreviewAcknowledged: z.boolean(),
      mcpReady: z.boolean(),
      sandboxExecution: z.discriminatedUnion("available", [
        z.object({
          available: z.literal(true),
          provider: z.string(),
          artifactGeneration: z.number().int(),
          runtimeVersion: z.string(),
          networkProfile: z.literal("package-install-v1"),
        }),
        z.object({
          available: z.literal(false),
          provider: z.string(),
          reason: z.string(),
        }),
      ]),
    }),
  }),
  runtimeVersions: z.object({
    piDurable: z.string(),
    piHarness: z.string(),
    computer: z.string(),
    codeMode: z.string(),
    mcp: z.string(),
    wrangler: z.string(),
  }),
});

export type DeploymentCapabilities = z.infer<typeof deploymentCapabilitiesSchema>;
