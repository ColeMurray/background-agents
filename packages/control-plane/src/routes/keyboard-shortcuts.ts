import { parseBody } from "./body";
import { Hono } from "hono";
import { keyboardShortcutPreferencesPayloadSchema } from "@open-inspect/shared/types/keyboard-shortcuts";
import { KeyboardShortcutPreferencesStore } from "../db/keyboard-shortcut-preferences";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import {
  ACTIVE_SELF,
  activeSelf,
  json,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  type UserRouteContext,
} from "./shared";
import type { Env } from "../types";

async function handleGetKeyboardShortcuts(
  _request: Request,
  _env: Env,
  _params: object,
  ctx: UserRouteContext
): Promise<Response> {
  const shortcuts = await new KeyboardShortcutPreferencesStore(ctx.db).get(ctx.principal.userId);
  return json({ shortcuts });
}

async function handleSetKeyboardShortcuts(
  request: Request,
  _env: Env,
  _params: object,
  ctx: UserRouteContext
): Promise<Response> {
  const parsed = await parseBody(
    request,
    keyboardShortcutPreferencesPayloadSchema,
    "Invalid keyboard shortcuts"
  );
  if (parsed instanceof Response) return parsed;
  const shortcuts = await new KeyboardShortcutPreferencesStore(ctx.db).set(
    ctx.principal.userId,
    parsed.shortcuts
  );
  return json({ shortcuts });
}

export const keyboardShortcutRoutes = new Hono<ControlPlaneHonoEnv>();

keyboardShortcutRoutes.get(
  "/keyboard-shortcuts",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    authorization: ACTIVE_SELF,
    cacheControl: "private, no-store",
  }),
  (c) => dispatch(c, handleGetKeyboardShortcuts)
);

keyboardShortcutRoutes.put(
  "/keyboard-shortcuts",
  admit({ ...SCM_AGNOSTIC_HUMAN_USER_ROUTE, authorization: activeSelf({ auditAllowed: true }) }),
  (c) => dispatch(c, handleSetKeyboardShortcuts)
);
