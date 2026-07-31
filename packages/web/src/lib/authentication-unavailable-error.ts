export class AuthenticationUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("Authentication is unavailable", { cause });
    this.name = "AuthenticationUnavailableError";
  }
}
