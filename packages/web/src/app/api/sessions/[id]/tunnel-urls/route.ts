import { controlPlaneUserFetch } from "@/lib/control-plane";

/**
 * The sandbox's preview-port URLs. Unlike `sandbox-access` it carries no terminal, editor or
 * desktop credentials, so the session page can keep preview links current without the viewer
 * counting as having opened the sandbox.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const response = await controlPlaneUserFetch(`/sessions/${encodeURIComponent(id)}/tunnel-urls`, {
    cache: "no-store",
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "Content-Type": response.headers.get("Content-Type") ?? "application/json",
      "Cache-Control": "private, no-store",
      Vary: "Cookie",
    },
  });
}
