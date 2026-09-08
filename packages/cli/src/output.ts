export type OutputFormat = "text" | "json" | "stream-json";

interface OutputWriters {
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
}

/** Keeps result output separate from diagnostics, including MCP-safe stderr logging. */
export class Output {
  private readonly stdout: (value: string) => void;
  private readonly stderr: (value: string) => void;

  constructor(
    readonly format: OutputFormat,
    writers: OutputWriters = {}
  ) {
    this.stdout = writers.stdout ?? ((value) => process.stdout.write(value));
    this.stderr = writers.stderr ?? ((value) => process.stderr.write(value));
  }

  result(value: unknown): void {
    if (this.format === "text") {
      this.stdout(`${formatText(value)}\n`);
      return;
    }
    this.stdout(`${JSON.stringify(value, null, this.format === "json" ? 2 : undefined)}\n`);
  }

  error(message: string): void {
    this.stderr(`${message}\n`);
  }

  failure(cause: unknown): void {
    const envelope = errorEnvelope(cause);
    this.stderr(
      this.format === "text"
        ? `${formatText(envelope)}\n`
        : `${JSON.stringify(envelope, null, this.format === "json" ? 2 : undefined)}\n`
    );
  }
}

function formatText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "OK";
  if (value !== null && typeof value === "object") {
    return Object.entries(value)
      .map(
        ([key, child]) =>
          `${key}: ${typeof child === "object" ? JSON.stringify(child) : String(child)}`
      )
      .join("\n");
  }
  return String(value);
}
import { errorEnvelope } from "./errors.js";
