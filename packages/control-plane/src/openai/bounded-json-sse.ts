type BoundedJsonSseLimits = {
  maxTotalBytes: number;
  maxEventBytes: number;
  maxEvents: number;
};

export class BoundedJsonSseAbortError extends Error {}
export class InvalidBoundedJsonSseError extends Error {}

/** Races an operation against an abort signal, including operations that ignore the signal. */
export function waitForAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new BoundedJsonSseAbortError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new BoundedJsonSseAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

/** Decodes bounded JSON SSE events and stops reading when its consumer returns. */
export async function* decodeBoundedJsonSse(
  response: Response,
  signal: AbortSignal,
  limits: BoundedJsonSseLimits
): AsyncGenerator<unknown> {
  if (!response.body) throw new InvalidBoundedJsonSseError();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let lineBuffer = "";
  let eventData = "";
  let eventDataBytes = 0;
  let totalBytes = 0;
  let eventCount = 0;

  try {
    while (true) {
      const { done, value } = await waitForAbort(reader.read(), signal);
      if (done) return;
      totalBytes += value.byteLength;
      if (totalBytes > limits.maxTotalBytes) throw new InvalidBoundedJsonSseError();
      lineBuffer += decoder.decode(value, { stream: true });

      let newlineIndex = lineBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        let line = lineBuffer.slice(0, newlineIndex);
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);

        if (line === "") {
          if (eventData) {
            eventCount += 1;
            if (eventCount > limits.maxEvents) throw new InvalidBoundedJsonSseError();
            let event: unknown;
            try {
              event = JSON.parse(eventData);
            } catch {
              throw new InvalidBoundedJsonSseError();
            }
            yield event;
            eventData = "";
            eventDataBytes = 0;
          }
        } else if (line.startsWith("data:")) {
          const data = line.slice(5).replace(/^ /, "");
          eventDataBytes += (eventData ? 1 : 0) + encoder.encode(data).byteLength;
          eventData += eventData ? `\n${data}` : data;
          if (eventDataBytes > limits.maxEventBytes) throw new InvalidBoundedJsonSseError();
        }
        newlineIndex = lineBuffer.indexOf("\n");
      }
      if (
        lineBuffer.length > limits.maxEventBytes ||
        encoder.encode(lineBuffer).byteLength > limits.maxEventBytes
      ) {
        throw new InvalidBoundedJsonSseError();
      }
    }
  } catch (error) {
    if (error instanceof BoundedJsonSseAbortError || signal.aborted) throw error;
    if (error instanceof InvalidBoundedJsonSseError) throw error;
    throw new InvalidBoundedJsonSseError();
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
