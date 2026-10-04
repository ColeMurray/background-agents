import type { ReactNode } from "react";

/** Provider-specific binding entry; `TeamChannels` keeps only shared orchestration. */
export interface BindingEditor {
  providerLabel: string;
  bindLabel: string;
  /** Provider-level lock, such as denied Slack channel discovery. */
  locked: boolean;
  /** Trimmed external ID to bind, valid only when `canSubmit` is true. */
  externalId: string;
  canSubmit: boolean;
  /** Clear the entered ID after a successful bind. */
  clearDraft: () => void;
  /** Restore initial entry state when switching providers. */
  reset: () => void;
  field: ReactNode;
  footer: ReactNode;
  displayName: (externalId: string) => string;
  unbindLabel: (externalId: string) => string;
}

export interface BindingEditorParams {
  id: string;
  /** Shared form disablement: missing capability, pending mutation, or unloaded bindings. */
  disabled: boolean;
}
