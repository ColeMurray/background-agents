import { describe, expect, it } from "vitest";
import type { ObjectStorageMetadata } from "../../storage/object-storage";
import {
  createPartialStoredObjectResponse,
  createRangeNotSatisfiableResponse,
  createStoredObjectResponse,
} from "./stored-object-response";

function metadata(contentType = "image/png"): ObjectStorageMetadata {
  return {
    size: 10,
    httpEtag: '"etag"',
    writeHttpMetadata(headers) {
      headers.set("Content-Type", contentType);
    },
  };
}

function body(): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.close();
    },
  });
}

describe("createStoredObjectResponse", () => {
  it("creates a full-object response with canonical headers", () => {
    const response = createStoredObjectResponse(body(), metadata(), "image/png");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Length")).toBe("10");
  });

  it("creates a partial response with range headers", () => {
    const response = createPartialStoredObjectResponse(body(), metadata(), "image/png", {
      start: 2,
      end: 5,
      length: 4,
      totalSize: 10,
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(response.headers.get("Content-Length")).toBe("4");
  });

  it("creates an unsatisfied range response", async () => {
    const response = createRangeNotSatisfiableResponse(10);

    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */10");
    await expect(response.json()).resolves.toEqual({
      error: "Requested range is not satisfiable",
    });
  });
});
