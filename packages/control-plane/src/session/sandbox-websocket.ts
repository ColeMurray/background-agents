export function getSandboxWebSocketId(url: URL): string | null {
  return url.searchParams.get("sandbox_id");
}
