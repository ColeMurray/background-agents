import { Hono } from "hono";
import { keyboardShortcutPreferencesPayloadSchema } from "@open-inspect/shared/types/keyboard-shortcuts";
import { KeyboardShortcutPreferencesStore } from "../db/keyboard-shortcut-preferences";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { ACTIVE_SELF, activeSelf, error, json, SCM_AGNOSTIC_HUMAN_USER_ROUTE } from "./shared";

export const keyboardShortcutRoutes = new Hono<ControlPlaneHonoEnv>();

keyboardShortcutRoutes.get(
  "/keyboard-shortcuts",
  admit({ ...SCM_AGNOSTIC_HUMAN_USER_ROUTE, authorization: ACTIVE_SELF }),
  async (c) => {
    const { ctx } = c.var.admitted;
    const shortcuts = await new KeyboardShortcutPreferencesStore(ctx.db).get(ctx.principal.userId);
    return json({ shortcuts });
  }
);

keyboardShortcutRoutes.put(
  "/keyboard-shortcuts",
  admit({ ...SCM_AGNOSTIC_HUMAN_USER_ROUTE, authorization: activeSelf({ auditAllowed: true }) }),
  async (c) => {
    const { request, ctx } = c.var.admitted;
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
);
