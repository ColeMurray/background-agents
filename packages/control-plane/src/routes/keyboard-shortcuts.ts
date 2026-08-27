import { updateKeyboardShortcutPreferencesSchema } from "@open-inspect/shared/types/keyboard-shortcuts";
import { KeyboardShortcutPreferencesStore } from "../db/keyboard-shortcut-preferences";
import type { Env } from "../types";
import {
  defineRoutes,
  error,
  json,
  parsePattern,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  type RequestContext,
  type Route,
} from "./shared";

function canonicalUserId(ctx: RequestContext): string | null {
  if (ctx.principal?.kind === "user") return ctx.principal.userId;
  if (ctx.principal?.kind === "service") return ctx.principal.actor?.canonicalUserId ?? null;
  return null;
}

async function getPreferences(
  _request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const userId = canonicalUserId(ctx);
  if (!userId) return error("Canonical user required", 403);
  const shortcuts = await new KeyboardShortcutPreferencesStore(ctx.db).get(userId);
  return json({ shortcuts });
}

async function updatePreferences(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const userId = canonicalUserId(ctx);
  if (!userId) return error("Canonical user required", 403);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON body", 400);
  }
  const parsed = updateKeyboardShortcutPreferencesSchema.safeParse(body);
  if (!parsed.success) return error("Invalid keyboard shortcuts", 400);
  const shortcuts = await new KeyboardShortcutPreferencesStore(ctx.db).set(
    userId,
    parsed.data.shortcuts
  );
  return json({ shortcuts });
}

export const keyboardShortcutRoutes: Route[] = defineRoutes(SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, [
  { method: "GET", pattern: parsePattern("/keyboard-shortcuts"), handler: getPreferences },
  { method: "PUT", pattern: parsePattern("/keyboard-shortcuts"), handler: updatePreferences },
]);
