import { REPO_IMAGE_CALLBACK_TOKEN_PATTERN } from "../repo-images/auth";

function getBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  return token || null;
}

export function getRepoImageCallbackBearerToken(request: Request): string | null {
  const token = getBearerToken(request);
  if (!token || !REPO_IMAGE_CALLBACK_TOKEN_PATTERN.test(token)) return null;
  return token;
}
