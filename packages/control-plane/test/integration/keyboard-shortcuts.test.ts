import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { DEFAULT_KEYBOARD_SHORTCUTS } from "@open-inspect/shared/types/keyboard-shortcuts";
import { KeyboardShortcutPreferencesStore } from "../../src/db/keyboard-shortcut-preferences";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

const customShortcuts = {
  ...DEFAULT_KEYBOARD_SHORTCUTS,
  "open-command-menu": { code: "KeyP", primary: true, alt: false, shift: false },
};

describe("keyboard shortcut preferences", () => {
  beforeEach(cleanD1Tables);

  it("returns defaults when the authenticated user has no saved preferences", async () => {
    const response = await serviceFetch("https://test.local/keyboard-shortcuts");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ shortcuts: DEFAULT_KEYBOARD_SHORTCUTS });
  });

  it("round trips a complete shortcut set for the authenticated user", async () => {
    const response = await serviceFetch("https://test.local/keyboard-shortcuts", {
      method: "PUT",
      body: JSON.stringify({ shortcuts: customShortcuts }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ shortcuts: customShortcuts });

    const getResponse = await serviceFetch("https://test.local/keyboard-shortcuts");
    await expect(getResponse.json()).resolves.toEqual({ shortcuts: customShortcuts });
  });

  it("rejects malformed and duplicate shortcut sets", async () => {
    const duplicate = {
      ...DEFAULT_KEYBOARD_SHORTCUTS,
      "new-session": DEFAULT_KEYBOARD_SHORTCUTS["open-command-menu"],
    };
    const response = await serviceFetch("https://test.local/keyboard-shortcuts", {
      method: "PUT",
      body: JSON.stringify({ shortcuts: duplicate }),
    });
    expect(response.status).toBe(400);

    const incompleteResponse = await serviceFetch("https://test.local/keyboard-shortcuts", {
      method: "PUT",
      body: JSON.stringify({ shortcuts: {} }),
    });
    expect(incompleteResponse.status).toBe(400);
  });

  it("isolates records by canonical user ID", async () => {
    await env.DB.prepare(
      `INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, 1, 1, 1), (?, ?, ?, 1, 1, 1)`
    )
      .bind(
        "11111111111111111111111111111111",
        "First user",
        "first@example.com",
        "22222222222222222222222222222222",
        "Second user",
        "second@example.com"
      )
      .run();
    const store = new KeyboardShortcutPreferencesStore(env.DB);
    await store.set("11111111111111111111111111111111", customShortcuts);

    await expect(store.get("22222222222222222222222222222222")).resolves.toEqual(
      DEFAULT_KEYBOARD_SHORTCUTS
    );
    await expect(store.get("11111111111111111111111111111111")).resolves.toEqual(customShortcuts);
  });

  it("fills missing stored actions from current defaults", async () => {
    await serviceFetch("https://test.local/keyboard-shortcuts");
    const { "toggle-sidebar": _, ...olderRecord } = customShortcuts;
    await env.DB.prepare(
      "INSERT INTO keyboard_shortcut_preferences (user_id, shortcuts, updated_at) VALUES (?, ?, 1)"
    )
      .bind("11111111111111111111111111111111", JSON.stringify(olderRecord))
      .run();

    const response = await serviceFetch("https://test.local/keyboard-shortcuts");
    await expect(response.json()).resolves.toEqual({
      shortcuts: {
        ...olderRecord,
        "toggle-sidebar": DEFAULT_KEYBOARD_SHORTCUTS["toggle-sidebar"],
      },
    });
  });

  it("falls back to defaults when a newly filled action collides with an older override", async () => {
    await serviceFetch("https://test.local/keyboard-shortcuts");
    const { "toggle-sidebar": _, ...olderRecord } = customShortcuts;
    olderRecord["open-command-menu"] = DEFAULT_KEYBOARD_SHORTCUTS["toggle-sidebar"];
    olderRecord["send-prompt"] = DEFAULT_KEYBOARD_SHORTCUTS["new-session"];
    olderRecord["new-session"] = DEFAULT_KEYBOARD_SHORTCUTS["send-prompt"];
    await env.DB.prepare(
      "INSERT INTO keyboard_shortcut_preferences (user_id, shortcuts, updated_at) VALUES (?, ?, 1)"
    )
      .bind("11111111111111111111111111111111", JSON.stringify(olderRecord))
      .run();

    const response = await serviceFetch("https://test.local/keyboard-shortcuts");
    await expect(response.json()).resolves.toEqual({
      shortcuts: {
        ...DEFAULT_KEYBOARD_SHORTCUTS,
        "send-prompt": olderRecord["send-prompt"],
        "new-session": olderRecord["new-session"],
      },
    });
  });

  it("requires a canonical user principal", async () => {
    const response = await serviceFetch("https://test.local/keyboard-shortcuts", {
      service: "slack-bot",
      actor: "slack:U123",
    });
    expect(response.status).toBe(403);
  });
});
