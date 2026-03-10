import type { NextRequest } from "next/server";
import { proxyIntegrationRequest } from "@/lib/integration-route";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyIntegrationRequest(id, `/integration-settings/${id}/repos`, "Failed to fetch repo settings");
}
