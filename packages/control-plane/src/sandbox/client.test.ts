import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildModalSandboxDashboardUrl,
  buildModalWorkspaceSlug,
  createModalClient,
} from "./client";

describe("buildModalWorkspaceSlug", () => {
  it("uses the raw workspace for the default Modal environment", () => {
    expect(buildModalWorkspaceSlug("acme")).toBe("acme");
    expect(buildModalWorkspaceSlug("acme", "")).toBe("acme");
    expect(buildModalWorkspaceSlug("acme", "main")).toBe("acme");
  });

  it("appends non-main Modal environments for endpoint URLs", () => {
    expect(buildModalWorkspaceSlug("acme", "production")).toBe("acme-production");
  });
});

describe("buildModalSandboxDashboardUrl", () => {
  it("builds a Modal dashboard URL for a sandbox object", () => {
    expect(
      buildModalSandboxDashboardUrl({
        workspace: "acme",
        providerObjectId: "sb-123",
      })
    ).toBe(
      "https://modal.com/apps/acme/main/deployed/open-inspect?activeTab=sandboxes&sandboxId=sb-123"
    );
  });

  it("supports an explicit Modal environment", () => {
    expect(
      buildModalSandboxDashboardUrl({
        workspace: "acme",
        environment: "production",
        providerObjectId: "sb-123",
      })
    ).toBe(
      "https://modal.com/apps/acme/production/deployed/open-inspect?activeTab=sandboxes&sandboxId=sb-123"
    );
  });

  it("encodes URL components", () => {
    expect(
      buildModalSandboxDashboardUrl({
        workspace: "acme team",
        environment: "prod/main",
        providerObjectId: "sb 123/456?x=1",
      })
    ).toBe(
      "https://modal.com/apps/acme%20team/prod%2Fmain/deployed/open-inspect?activeTab=sandboxes&sandboxId=sb%20123%2F456%3Fx%3D1"
    );
  });

  it("returns null when required inputs are missing", () => {
    expect(
      buildModalSandboxDashboardUrl({
        workspace: undefined,
        providerObjectId: "sb-123",
      })
    ).toBeNull();
    expect(
      buildModalSandboxDashboardUrl({
        workspace: "acme",
        providerObjectId: null,
      })
    ).toBeNull();
  });
});

describe("ModalClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the Modal environment in endpoint URLs", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { status: "ok", service: "modal" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const client = createModalClient("secret", "acme", "production");
    await client.health();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://acme-production--open-inspect-api-health.modal.run"
    );
  });
});
