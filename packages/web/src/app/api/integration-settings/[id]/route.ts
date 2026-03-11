import type { NextRequest } from "next/server";
import { proxyIntegrationRequest } from "@/lib/integration-route";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyIntegrationRequest(
    id,
    `/integration-settings/${id}`,
    "Failed to fetch integration settings"
  );
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyIntegrationRequest(id, `/integration-settings/${id}`, "Failed to update integration settings", {
    method: "PUT",
    body: JSON.stringify(await request.json()),
  });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return proxyIntegrationRequest(id, `/integration-settings/${id}`, "Failed to delete integration settings", {
    method: "DELETE",
  });
}
