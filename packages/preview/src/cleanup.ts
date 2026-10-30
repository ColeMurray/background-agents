/** Releases acquired resources newest first, attempting every release even after one fails. */
export class Cleanup {
  private readonly steps: Array<() => unknown> = [];

  defer(step: () => unknown): void {
    this.steps.push(step);
  }

  /** Runs each deferred step once and returns the errors they threw. */
  async run(): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const step of this.steps.splice(0).reverse()) {
      try {
        await step();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }
}
