import {
  checkHarnessCompatibility,
  getHarnessLabel,
  isValidHarness,
  type HarnessId,
} from "@open-inspect/shared/harnesses";
import { isValidModel } from "@open-inspect/shared/models";
import type { Env } from "./types";

/** Bounded v1 deployment configuration; not the integration-settings catalog. */
const SUPPORTED_HARNESSES = ["claude", "opencode"] as const satisfies readonly HarnessId[];

export interface LaunchConfig {
  readonly harness: HarnessId;
  readonly model: string;
}

export class LaunchConfigError extends Error {
  constructor(message: string) {
    super(
      `Discord task configuration is invalid. ${message} Ask an administrator to update the bot deployment.`
    );
    this.name = "LaunchConfigError";
  }
}

const configs = new WeakMap<Env, LaunchConfig | LaunchConfigError>();

function validateLaunchConfig(env: Env): LaunchConfig {
  const harness = env.HARNESS;
  if (!isValidHarness(harness) || !SUPPORTED_HARNESSES.some((id) => id === harness)) {
    throw new LaunchConfigError("Set HARNESS to claude or opencode.");
  }
  if (typeof env.DEFAULT_MODEL !== "string" || !isValidModel(env.DEFAULT_MODEL)) {
    throw new LaunchConfigError(
      "Set DEFAULT_MODEL to a supported model ID from the model catalog."
    );
  }
  if (checkHarnessCompatibility(harness, env.DEFAULT_MODEL)) {
    throw new LaunchConfigError(
      `Set DEFAULT_MODEL to a model compatible with ${getHarnessLabel(harness)}.`
    );
  }
  return Object.freeze({ harness, model: env.DEFAULT_MODEL });
}

/** Lazy binding initialization: validate once per env, never on callback-only requests. */
export function getLaunchConfig(env: Env): LaunchConfig {
  let config = configs.get(env);
  if (!config) {
    try {
      config = validateLaunchConfig(env);
    } catch (error) {
      if (!(error instanceof LaunchConfigError)) throw error;
      config = error;
    }
    configs.set(env, config);
  }
  if (config instanceof LaunchConfigError) throw config;
  return config;
}
