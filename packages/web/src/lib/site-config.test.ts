import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("site-config", () => {
  const originalAppName = process.env.NEXT_PUBLIC_APP_NAME;
  const originalShortName = process.env.NEXT_PUBLIC_APP_SHORT_NAME;
  const originalIconUrl = process.env.NEXT_PUBLIC_APP_ICON_URL;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalAppName === undefined) {
      delete process.env.NEXT_PUBLIC_APP_NAME;
    } else {
      process.env.NEXT_PUBLIC_APP_NAME = originalAppName;
    }
    if (originalShortName === undefined) {
      delete process.env.NEXT_PUBLIC_APP_SHORT_NAME;
    } else {
      process.env.NEXT_PUBLIC_APP_SHORT_NAME = originalShortName;
    }
    if (originalIconUrl === undefined) {
      delete process.env.NEXT_PUBLIC_APP_ICON_URL;
    } else {
      process.env.NEXT_PUBLIC_APP_ICON_URL = originalIconUrl;
    }
  });

  it("falls back to Open-Inspect when NEXT_PUBLIC_APP_NAME is unset", async () => {
    delete process.env.NEXT_PUBLIC_APP_NAME;
    const { APP_NAME } = await import("./site-config");
    expect(APP_NAME).toBe("Open-Inspect");
  });

  it("falls back to Open-Inspect when NEXT_PUBLIC_APP_NAME is empty", async () => {
    process.env.NEXT_PUBLIC_APP_NAME = "   ";
    const { APP_NAME } = await import("./site-config");
    expect(APP_NAME).toBe("Open-Inspect");
  });

  it("uses NEXT_PUBLIC_APP_NAME when set", async () => {
    process.env.NEXT_PUBLIC_APP_NAME = "Acme Bot";
    const { APP_NAME } = await import("./site-config");
    expect(APP_NAME).toBe("Acme Bot");
  });

  it("trims surrounding whitespace from NEXT_PUBLIC_APP_NAME", async () => {
    process.env.NEXT_PUBLIC_APP_NAME = "  Acme Bot  ";
    const { APP_NAME } = await import("./site-config");
    expect(APP_NAME).toBe("Acme Bot");
  });

  it("APP_SHORT_NAME defaults to 'Inspect' when nothing is set", async () => {
    delete process.env.NEXT_PUBLIC_APP_NAME;
    delete process.env.NEXT_PUBLIC_APP_SHORT_NAME;
    const { APP_SHORT_NAME } = await import("./site-config");
    expect(APP_SHORT_NAME).toBe("Inspect");
  });

  it("APP_SHORT_NAME falls through to APP_NAME when only NEXT_PUBLIC_APP_NAME is set", async () => {
    process.env.NEXT_PUBLIC_APP_NAME = "Acme Bot";
    delete process.env.NEXT_PUBLIC_APP_SHORT_NAME;
    const { APP_SHORT_NAME } = await import("./site-config");
    expect(APP_SHORT_NAME).toBe("Acme Bot");
  });

  it("APP_SHORT_NAME uses NEXT_PUBLIC_APP_SHORT_NAME when set, even alongside APP_NAME", async () => {
    process.env.NEXT_PUBLIC_APP_NAME = "Acme Bot";
    process.env.NEXT_PUBLIC_APP_SHORT_NAME = "Acme";
    const { APP_SHORT_NAME } = await import("./site-config");
    expect(APP_SHORT_NAME).toBe("Acme");
  });

  it("APP_ICON_URL is empty when NEXT_PUBLIC_APP_ICON_URL is unset", async () => {
    delete process.env.NEXT_PUBLIC_APP_ICON_URL;
    const { APP_ICON_URL } = await import("./site-config");
    expect(APP_ICON_URL).toBe("");
  });

  it("APP_ICON_URL reflects NEXT_PUBLIC_APP_ICON_URL", async () => {
    process.env.NEXT_PUBLIC_APP_ICON_URL = "/branding/logo.svg";
    const { APP_ICON_URL } = await import("./site-config");
    expect(APP_ICON_URL).toBe("/branding/logo.svg");
  });
});
