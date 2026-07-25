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
  it("nests the application gate and children inside the authentication provider", () => {
    const child = <div>Protected application</div>;
    const authProvider = findByType(Providers({ children: child }), AuthSessionProvider);

    expect(authProvider).toBeDefined();

    const gate = findByType(
      (authProvider as ReactElement<{ children?: ReactNode }>).props.children,
      WebSessionGate
    );

    expect(gate).toBeDefined();
    expect((gate as ReactElement<{ children?: ReactNode }>).props.children).toBe(child);
  });
});
