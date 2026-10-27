import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { rejectMissingBrowserSessionCookie } from "@/lib/browser-session-guard";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const response = await controlPlaneUserFetch(`/mcp-servers/${encodeURIComponent(id)}`);
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch MCP server:", error);
    return NextResponse.json({ error: "Failed to fetch MCP server" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const rejection = rejectMissingBrowserSessionCookie(request);
  if (rejection) return rejection;

  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const response = await controlPlaneUserFetch(`/mcp-servers/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to update MCP server:", error);
    return NextResponse.json({ error: "Failed to update MCP server" }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const response = await controlPlaneUserFetch(`/mcp-servers/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to delete MCP server:", error);
    return NextResponse.json({ error: "Failed to delete MCP server" }, { status: 500 });
  }
}
