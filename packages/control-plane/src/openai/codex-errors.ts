export class OpenAICodexUpstreamError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

export class InvalidOpenAICodexResponseError extends Error {}
