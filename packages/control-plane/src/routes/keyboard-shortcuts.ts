import { keyboardShortcutPreferencesPayloadSchema } from "@open-inspect/shared/types/keyboard-shortcuts";
import { KeyboardShortcutPreferencesStore } from "../db/keyboard-shortcut-preferences";
import type { Env } from "../types";
import {
  ACTIVE_SELF,
  activeSelf,
  defineRoutes,
  error,
  json,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  type Route,
  type UserRouteContext,
} from "./shared";

async function getPreferences(
  _request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const shortcuts = await new KeyboardShortcutPreferencesStore(ctx.db).get(ctx.principal.userId);
  return json({ shortcuts });
}

async function updatePreferences(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON body", 400);
  }
  const parsed = keyboardShortcutPreferencesPayloadSchema.safeParse(body);
  if (!parsed.success) return error("Invalid keyboard shortcuts", 400);
  const shortcuts = await new KeyboardShortcutPreferencesStore(ctx.db).set(
    ctx.principal.userId,
    parsed.data.shortcuts
  );
  return json({ shortcuts });
}

export const keyboardShortcutRoutes: Route[] = defineRoutes(SCM_AGNOSTIC_HUMAN_USER_ROUTE, [
  {
    method: "GET",
    path: "/keyboard-shortcuts",
    authorization: ACTIVE_SELF,
    handler: getPreferences,
  },
  {
    method: "PUT",
    path: "/keyboard-shortcuts",
    authorization: activeSelf({ auditAllowed: true }),
    handler: updatePreferences,
  },
]);
