import { describe, expect, it } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

import { WebSessionGate } from "@/components/web-session-gate";
import { AuthSessionProvider } from "@/lib/auth-session";
import { Providers } from "./providers";

function findByType(node: ReactNode, type: unknown): ReactElement | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByType(child, type);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  if (node.type === type) return node;
  return findByType((node.props as { children?: ReactNode }).children, type);
}

describe("Providers", () => {
  it("places the application behind the client authentication provider", () => {
    expect(findByType(Providers({ children: null }), AuthSessionProvider)).toBeDefined();
  });

  it("places application children behind the web-session gate", () => {
    const child = <div>Protected application</div>;
    const gate = findByType(Providers({ children: child }), WebSessionGate);

    expect(gate).toBeDefined();
    expect((gate as ReactElement<{ children?: ReactNode }>).props.children).toBe(child);
  });
});
