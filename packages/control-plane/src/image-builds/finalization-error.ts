/**
 * Provider finalization failed before the artifact could be durably fenced.
 *
 * Only `definitely_not_created` is retryable. `ambiguous` means a provider
 * artifact may exist, so another creation attempt could leak a duplicate.
 */
export class ImageBuildFinalizationAttemptError extends Error {
  constructor(
    message: string,
    readonly outcome: "definitely_not_created" | "ambiguous",
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ImageBuildFinalizationAttemptError";
  }
}
