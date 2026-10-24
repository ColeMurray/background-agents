"use client";

import useSWR from "swr";
import {
  DEPLOYMENT_CAPABILITIES_KEY,
  fetchDeploymentCapabilities,
} from "@/lib/deployment-capabilities-api";

export function useDeploymentCapabilities() {
  return useSWR(DEPLOYMENT_CAPABILITIES_KEY, fetchDeploymentCapabilities, {
    revalidateOnFocus: false,
  });
}
