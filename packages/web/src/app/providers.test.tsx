import { describe, expect, it } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { SessionProvider } from "next-auth/react";

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
  it("keeps the SessionProvider focus refetch disabled", () => {
    // A focus refetch would make /api/auth/session a second session-cookie
    // writer racing the oi-refresh rotation write; the rotation machinery
    // depends on oi-refresh being the only focus/interval-triggered writer.
    const sessionProvider = findByType(Providers({ children: null }), SessionProvider);
    expect(sessionProvider).toBeDefined();
    expect(
      (sessionProvider as ReactElement<{ refetchOnWindowFocus?: boolean }>).props
    ).toMatchObject({ refetchOnWindowFocus: false });
  });
});
