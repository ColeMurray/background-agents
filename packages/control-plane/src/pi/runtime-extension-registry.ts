import type { Extension } from "@earendil-works/pi-durable";
import type { FeatureCapabilityMode, PiFeatureCapabilityMatrix } from "@open-inspect/shared";
import type { ExtensionContribution } from "../harness/extension-assembler";
import type { PiSessionContext } from "./session-context-contract";
import type { PiToolPolicyDelegate } from "./tool-policy-types";

export interface PiRuntimeExtensionHost {
  getSessionId(): Promise<string | undefined>;
  attributedOperationId(): Promise<string | null>;
  currentOperationId(): Promise<string | null>;
  fetchSession(sessionId: string, request: Request): Promise<Response>;
}

export interface PiRuntimeExtensionContributions {
  delegates: PiToolPolicyDelegate[];
  extensions: ExtensionContribution<Extension>[];
  ownsMcp: boolean;
}

export type PiRuntimeExtensionFactory = (
  host: PiRuntimeExtensionHost,
  sessionContext: PiSessionContext,
  capabilities: PiFeatureCapabilityMatrix,
  currentCapabilities: (
    signal?: AbortSignal
  ) => Promise<Readonly<Record<string, FeatureCapabilityMode>>>
) => PiRuntimeExtensionContributions;

let registeredFactory: PiRuntimeExtensionFactory | undefined;

/** Composition-root hook; core remains empty when no deployment extension is installed. */
export function registerPiRuntimeExtensionFactory(factory: PiRuntimeExtensionFactory): void {
  registeredFactory = factory;
}

export function createRegisteredPiRuntimeExtensions(
  host: PiRuntimeExtensionHost,
  sessionContext: PiSessionContext,
  capabilities: PiFeatureCapabilityMatrix,
  currentCapabilities: (
    signal?: AbortSignal
  ) => Promise<Readonly<Record<string, FeatureCapabilityMode>>>
): PiRuntimeExtensionContributions {
  return (
    registeredFactory?.(host, sessionContext, capabilities, currentCapabilities) ?? {
      delegates: [],
      extensions: [],
      ownsMcp: false,
    }
  );
}
