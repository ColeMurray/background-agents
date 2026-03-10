import type { NextRequest } from "next/server";
import { proxyIntegrationRequest } from "@/lib/integration-route";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; owner: string; name: string }> }
) {
  const { id, owner, name } = await params;
  return proxyIntegrationRequest(
    id,
    `/integration-settings/${id}/repos/${owner}/${name}`,
    "Failed to fetch repo integration settings"
  );
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; owner: string; name: string }> }
) {
  const { id, owner, name } = await params;
  return proxyIntegrationRequest(
    id,
    `/integration-settings/${id}/repos/${owner}/${name}`,
    "Failed to update repo integration settings",
    {
      method: "PUT",
      body: JSON.stringify(await request.json()),
    }
  );
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; owner: string; name: string }> }
) {
  const { id, owner, name } = await params;
  return proxyIntegrationRequest(
    id,
    `/integration-settings/${id}/repos/${owner}/${name}`,
    "Failed to delete repo integration settings",
    {
      method: "DELETE",
    }
  );
}
