import { describe, expect, it } from "vitest";
import { buildVercelBootstrapScript } from "./bootstrap";

describe("buildVercelBootstrapScript", () => {
  it.each(["fluxbox.tar.xz", "libvncserver.tar.gz", "x11vnc.tar.gz", "novnc.tar.gz"])(
    "verifies %s before extraction",
    (archive) => {
      const script = buildVercelBootstrapScript();
      const verification = `/${archive}" | sha256sum -c -`;
      const extraction = `tar -x`;

      expect(script).toContain(verification);
      expect(script.indexOf(verification)).toBeLessThan(
        script.indexOf(extraction, script.indexOf(verification))
      );
    }
  );
});
