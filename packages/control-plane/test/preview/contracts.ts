// Shared browser-runner contract: do not import the control-plane implementation graph here.
export const PERSONAS = ["member", "owner", "viewer", "suspended", "expired", "anonymous"] as const;
export type Persona = (typeof PERSONAS)[number];
export const SCENARIOS = ["empty", "populated"] as const;
export type Scenario = (typeof SCENARIOS)[number];
export const PREVIEW_REPLY =
  "Authenticated preview: streamed through the real control plane and saved to history.";
export interface PreviewStackOptions {
  root: string;
  scenario?: Scenario;
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
}
/** The one way in for callers outside this package; `stack.ts` implements it. */
export type StartPreviewStack = (options: PreviewStackOptions) => Promise<PreviewStackHandle>;
export interface PreviewStackHandle {
  manifest: PreviewManifest;
  /** Per-run credentials, deliberately kept out of the manifest: each signs a browser in. */
  signInLinks: Record<Persona, string>;
  backend: {
    failures(): string[];
    request(
      path: string,
      init?: { method?: string; body?: unknown; persona?: Persona }
    ): Promise<Response>;
    modal: {
      holdTurns(): void;
      releaseTurns(): void;
      state: { promptsReceived: Array<{ messageId: string; content: string }> };
    };
  };
  /** The first failure while the stack runs: Next exiting, a fixture failure or run expiry. */
  failure: Promise<Error>;
  close(): Promise<void>;
}
export interface PreviewManifest {
  schemaVersion: 1;
  runId: string;
  pid: number;
  root: string;
  sourceRevision: string;
  dirty: boolean;
  scenario: Scenario;
  fixtureSchemaVersion: 1;
  webOrigin: string;
  controlPlaneOrigin: string;
  startedAtMs: number;
  expiresAtMs: number;
  aliases: Record<string, string>;
  personas: Record<
    Persona,
    { userId: string | null; statePath: string; browserSession: string; expiresAtMs: number }
  >;
  logs: { web: string };
  checks: string[];
  status: "ready";
  timings: { backendMs: number; webReadyMs: number; totalMs: number };
}
