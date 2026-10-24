import { describe, expect, it } from "vitest";
import { describeProviderConformance } from "./conformance";
import { EXTERNAL_ACTION_PROVIDER_DEFINITIONS } from "./definitions";
import type { ProviderFetch } from "./executor";

/**
 * Every provider definition must pass the same generic suite.
 *
 * The suite injects faults instead of calling a provider, so this file never
 * reaches a network.
 */
function createFetch(
  handler: (url: string, init: never) => Response | Promise<Response>
): ProviderFetch {
  return async (url, init) => handler(url, init as never);
}

describe("external action provider conformance", () => {
  for (const definition of EXTERNAL_ACTION_PROVIDER_DEFINITIONS) {
    describeProviderConformance(definition, createFetch);
  }

  it("registers no provider twice", () => {
    const keys = EXTERNAL_ACTION_PROVIDER_DEFINITIONS.map(
      (definition) => `${definition.provider}/${definition.action}`
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});
