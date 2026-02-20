export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function jsonError(message: string, status: number, code?: string): Response {
  return jsonResponse(
    {
      error: message,
      ...(code ? { code } : {}),
    },
    status
  );
}
