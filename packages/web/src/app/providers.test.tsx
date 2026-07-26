import { describe, expect, it } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { SWRConfig } from "swr";

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
  it("nests application children inside the shared SWR provider", () => {
    const child = <div>Protected application</div>;
    const provider = findByType(Providers({ children: child }), SWRConfig);

    expect(provider).toBeDefined();
    expect((provider as ReactElement<{ children?: ReactNode }>).props.children).toContain(child);
  });
});
