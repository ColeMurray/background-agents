import { SandboxProviderError } from "../provider";

/** A replaced reservation must abandon without writing another attempt's failure. */
export class SpawnSupersededError extends Error {
  constructor() {
    super("Spawn reservation superseded before its auth hash was published");
    this.name = "SpawnSupersededError";
  }
}

export class SandboxLaunchExpiredError extends SandboxProviderError {
  constructor() {
    super(
      "The sandbox timeout leaves no time before the final save begins. Increase the sandbox timeout or reduce the final snapshot buffer in the sandbox settings.",
      "transient"
    );
    this.name = "SandboxLaunchExpiredError";
  }
}
