import { afterEach, describe, expect, it, vi } from "vitest";

describe("sandbox-provider", () => {
  const originalPublicProvider = process.env.NEXT_PUBLIC_SANDBOX_PROVIDER;
  const originalProvider = process.env.SANDBOX_PROVIDER;

  afterEach(() => {
    vi.resetModules();
    if (originalPublicProvider === undefined) {
      delete process.env.NEXT_PUBLIC_SANDBOX_PROVIDER;
    } else {
      process.env.NEXT_PUBLIC_SANDBOX_PROVIDER = originalPublicProvider;
    }
    if (originalProvider === undefined) {
      delete process.env.SANDBOX_PROVIDER;
    } else {
      process.env.SANDBOX_PROVIDER = originalProvider;
    }
  });

  async function loadProvider() {
    vi.resetModules();
    return import("./sandbox-provider");
  }

  it("defaults to modal when no provider is configured", async () => {
    delete process.env.NEXT_PUBLIC_SANDBOX_PROVIDER;
    delete process.env.SANDBOX_PROVIDER;

    const { getPublicSandboxProvider, supportsRepoImages } = await loadProvider();

    expect(getPublicSandboxProvider()).toBe("modal");
    expect(supportsRepoImages()).toBe(true);
  });

  it("uses the public provider value when present", async () => {
    process.env.NEXT_PUBLIC_SANDBOX_PROVIDER = " vercel ";
    process.env.SANDBOX_PROVIDER = "daytona";

    const { getPublicSandboxProvider, supportsRepoImages } = await loadProvider();

    expect(getPublicSandboxProvider()).toBe("vercel");
    expect(supportsRepoImages()).toBe(true);
  });

  it("disables repo images for daytona", async () => {
    delete process.env.NEXT_PUBLIC_SANDBOX_PROVIDER;
    process.env.SANDBOX_PROVIDER = "daytona";

    const { getPublicSandboxProvider, supportsRepoImages } = await loadProvider();

    expect(getPublicSandboxProvider()).toBe("daytona");
    expect(supportsRepoImages()).toBe(false);
  });

  it("supports opencomputer with repo images", async () => {
    delete process.env.NEXT_PUBLIC_SANDBOX_PROVIDER;
    process.env.SANDBOX_PROVIDER = "opencomputer";

    const { getPublicSandboxProvider, supportsRepoImages } = await loadProvider();

    expect(getPublicSandboxProvider()).toBe("opencomputer");
    expect(supportsRepoImages()).toBe(true);
  });

  it("supports e2b with repo images", async () => {
    delete process.env.NEXT_PUBLIC_SANDBOX_PROVIDER;
    process.env.SANDBOX_PROVIDER = "e2b";

    const { getPublicSandboxProvider, supportsRepoImages } = await loadProvider();

    expect(getPublicSandboxProvider()).toBe("e2b");
    expect(supportsRepoImages()).toBe(true);
  });

  it("derives the unsupported-provider message from the image-build provider list", async () => {
    const { REPO_IMAGES_UNSUPPORTED_MESSAGE, getRepoImageProviders } = await loadProvider();

    // The message is the only copy of this sentence in the web app; the routes
    // import it rather than restating the provider list.
    expect(REPO_IMAGES_UNSUPPORTED_MESSAGE).toBe(
      "Image builds are only available when SANDBOX_PROVIDER=modal, vercel, opencomputer, or e2b"
    );
    for (const provider of getRepoImageProviders()) {
      expect(REPO_IMAGES_UNSUPPORTED_MESSAGE).toContain(provider);
    }
    // Daytona has no image support and must never be named.
    expect(REPO_IMAGES_UNSUPPORTED_MESSAGE).not.toContain("daytona");
  });

  it("throws for unsupported providers", async () => {
    process.env.NEXT_PUBLIC_SANDBOX_PROVIDER = "fly";

    const { getPublicSandboxProvider } = await loadProvider();

    expect(() => getPublicSandboxProvider()).toThrow("Invalid sandbox provider: fly");
  });
});
