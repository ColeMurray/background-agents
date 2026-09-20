/** Persisted execution metadata cannot be honored safely by the active provider. */
export class SandboxExecutionAdmissionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SandboxExecutionAdmissionError";
  }
}
