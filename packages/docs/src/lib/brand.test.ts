import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { brand, withAlpha } from "./brand";

const stylesheet = readFileSync(
  fileURLToPath(new URL("../app/globals.css", import.meta.url)),
  "utf8"
);

/** The `--color-fd-*` declarations inside one block of the stylesheet. */
function themeTokens(selector: string): Record<string, string> {
  const block = new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(stylesheet);
  if (!block) throw new Error(`no ${selector} block in globals.css`);
  return Object.fromEntries(
    [...block[1].matchAll(/--color-fd-([a-z-]+):\s*([^;]+);/g)].map(([, name, value]) => [
      name,
      value.trim(),
    ])
  );
}

const cssNames: Record<keyof (typeof brand)["light"], string> = {
  background: "background",
  foreground: "foreground",
  muted: "muted",
  mutedForeground: "muted-foreground",
  card: "card",
  secondary: "secondary",
  accentForeground: "accent-foreground",
  ring: "ring",
};

describe("brand palette", () => {
  // The favicon, social cards, and Mermaid diagrams read these values from
  // JavaScript. Drift against the stylesheet is invisible on the page itself.
  for (const [scheme, selector] of [
    ["light", "@theme"],
    ["dark", "\\.dark"],
  ] as const) {
    it(`matches the ${scheme} custom properties in globals.css`, () => {
      const tokens = themeTokens(selector);
      for (const [token, cssName] of Object.entries(cssNames)) {
        expect(brand[scheme][token as keyof (typeof brand)["light"]]).toBe(tokens[cssName]);
      }
    });
  }
});

describe("withAlpha", () => {
  it("expands a hex token into the rgba() form the stylesheet uses", () => {
    expect(withAlpha("#1a1a1a", 0.12)).toBe("rgba(26, 26, 26, 0.12)");
  });

  it("rejects a color it cannot parse", () => {
    expect(() => withAlpha("currentColor", 0.5)).toThrow(/expected a #rrggbb color/);
  });
});
