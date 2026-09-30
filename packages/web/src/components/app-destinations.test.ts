import { describe, expect, it } from "vitest";
import { APP_DESTINATIONS, PRIMARY_APP_DESTINATIONS } from "./app-destinations";

describe("app destinations", () => {
  it("makes teams discoverable without a workspace administration permission", () => {
    expect(PRIMARY_APP_DESTINATIONS).toContainEqual(
      expect.objectContaining({ label: "Teams", href: "/teams" })
    );
    const teams = APP_DESTINATIONS.find((destination) => destination.href === "/teams");
    expect(teams?.requiredPermission).toBe("sessions.read");
  });

  it("leaves the bare root available to the composer", () => {
    expect(APP_DESTINATIONS.map((destination): string => destination.href)).not.toContain("/");
  });
});
