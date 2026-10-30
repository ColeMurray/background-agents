// The launcher's output contract, shared with the browser suite. Dependency-free on purpose: the
// suite reads the launcher's ready line and must not import the control-plane graph.
export const PERSONAS = ["member", "owner", "viewer", "suspended", "expired", "anonymous"] as const;
export type Persona = (typeof PERSONAS)[number];
export const SCENARIOS = ["empty", "populated"] as const;
export type Scenario = (typeof SCENARIOS)[number];
export const TEAMS_MODES = ["off", "shadow", "on"] as const;
export type TeamsMode = (typeof TEAMS_MODES)[number];
export const PREVIEW_REPLY =
  "Authenticated preview: streamed through the real control plane and saved to history.";

/** The JSON line `npm run preview` prints once the stack is ready. */
export interface PreviewReady {
  status: "ready";
  pid: number;
  webOrigin: string;
  controlPlaneOrigin: string;
  /** The fake Modal peer; `/__smoke/state`, `/__smoke/hold` and `/__smoke/release` drive it. */
  modalOrigin: string;
  /** Private run directory, removed when the run stops. */
  runDir: string;
  logs: { web: string };
  scenario: Scenario;
  teamsEnforcement: TeamsMode;
  expiresAtMs: number;
  aliases: Record<string, string>;
  /** Canonical user IDs; null for the persona with no account. */
  userIds: Record<Persona, string | null>;
  /** Opening a link signs that browser in as its persona. Valid until the run stops. */
  signInLinks: Record<Persona, string>;
  /** The agent-browser session the launcher opened, or null with `--browser none`. */
  browserSession: string | null;
}
