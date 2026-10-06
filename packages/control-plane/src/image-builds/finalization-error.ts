/**
 * Provider finalization did not produce a fenced artifact this attempt.
 *
 * `definitely_not_created` is retryable: the request was rejected, so no
 * artifact can exist. `ambiguous` means one may exist with no way to find it,
 * so another creation attempt could leak a duplicate and the build fails
 * instead. `pending` is the middle ground an asynchronous provider needs: the
 * operation is durably recorded under a reserved name, so a later delivery
 * can reconcile that exact operation rather than submit another.
 */
export class ImageBuildFinalizationAttemptError extends Error {
  constructor(
    message: string,
    readonly outcome: "definitely_not_created" | "ambiguous" | "pending",
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ImageBuildFinalizationAttemptError";
  }
}
