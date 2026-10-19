import { deploymentCapabilitiesSchema } from "@open-inspect/shared";

export const DEPLOYMENT_CAPABILITIES_KEY = "/api/capabilities" as const;

/** Same-origin browser transport for the public, credential-free capability document. */
export async function fetchDeploymentCapabilities() {
  const response = await globalThis.fetch(DEPLOYMENT_CAPABILITIES_KEY, {
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error("Deployment capabilities are unavailable");
  return deploymentCapabilitiesSchema.parse(await response.json());
}
