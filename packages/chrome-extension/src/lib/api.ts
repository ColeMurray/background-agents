import { getWebAppUrl } from "@/lib/storage";
import type {
  Session,
  ListSessionsResponse,
  CreateSessionResponse,
  InstallationRepository,
} from "@open-inspect/shared";

/**
 * fetch wrapper that makes credentialed requests to the wrench web app.
 * cookies are included automatically because the extension has host_permissions
 * for the web app domain.
 */
async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const baseUrl = await getWebAppUrl();
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

  const response = await fetch(url, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown error");
    throw new ApiError(response.status, text);
  }

  return response.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: string
  ) {
    super(`API error ${status}: ${body}`);
    this.name = "ApiError";
  }
}

// ── auth ──

interface AuthSession {
  user: {
    name: string;
    email: string;
    image: string;
    id: string;
    login: string;
  };
}

/**
 * check if user is authenticated by hitting the nextauth session endpoint.
 * returns the session if valid, null otherwise.
 */
export async function checkAuth(): Promise<AuthSession | null> {
  try {
    const baseUrl = await getWebAppUrl();
    const response = await fetch(`${baseUrl}/api/auth/session`, {
      credentials: "include",
    });
    if (!response.ok) return null;
    const data = (await response.json()) as Record<string, unknown>;
    // nextauth returns an empty object when not authenticated
    if (!data.user) return null;
    return data as unknown as AuthSession;
  } catch {
    return null;
  }
}

// ── sessions ──

export async function listSessions(
  params: { limit?: number; offset?: number; status?: string; excludeStatus?: string } = {}
): Promise<ListSessionsResponse> {
  const query = new URLSearchParams();
  if (params.limit) query.set("limit", String(params.limit));
  if (params.offset) query.set("offset", String(params.offset));
  if (params.status) query.set("status", params.status);
  if (params.excludeStatus) query.set("excludeStatus", params.excludeStatus);
  const qs = query.toString();
  return apiFetch(`/api/sessions${qs ? `?${qs}` : ""}`);
}

interface CreateSessionParams {
  repoOwner: string;
  repoName: string;
  model?: string;
  reasoningEffort?: string;
  title?: string;
}

export async function createSession(params: CreateSessionParams): Promise<CreateSessionResponse> {
  return apiFetch("/api/sessions", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function getSession(sessionId: string): Promise<Session> {
  return apiFetch(`/api/sessions/${sessionId}`);
}

export async function sendPrompt(
  sessionId: string,
  content: string,
  model?: string,
  reasoningEffort?: string
): Promise<{ messageId: string }> {
  return apiFetch(`/api/sessions/${sessionId}/prompt`, {
    method: "POST",
    body: JSON.stringify({
      content,
      source: "extension",
      model,
      reasoningEffort,
    }),
  });
}

export async function fetchWsToken(sessionId: string): Promise<string> {
  const data = await apiFetch<{ token: string }>(`/api/sessions/${sessionId}/ws-token`, {
    method: "POST",
  });
  return data.token;
}

// ── repos ──

export async function listRepos(): Promise<InstallationRepository[]> {
  return apiFetch("/api/repos");
}
