import type { ObjectStorageMetadata } from "../../storage/object-storage";
import type { ByteRange } from "../requests/byte-range";

/** Create an HTTP response for a complete stored object. */
export function createStoredObjectResponse(
  body: ReadableStream,
  metadata: ObjectStorageMetadata,
  contentType: string
): Response {
  const headers = buildObjectHeaders(metadata, contentType);
  headers.set("Content-Length", String(metadata.size));
  return new Response(body, { headers });
}

export function createPartialStoredObjectResponse(
  body: ReadableStream,
  metadata: ObjectStorageMetadata,
  contentType: string,
  range: ByteRange
): Response {
  const headers = buildObjectHeaders(metadata, contentType);
  headers.set("Content-Range", `bytes ${range.start}-${range.end}/${range.totalSize}`);
  headers.set("Content-Length", String(range.length));
  return new Response(body, { status: 206, headers });
}

export function createRangeNotSatisfiableResponse(size: number): Response {
  return Response.json(
    { error: "Requested range is not satisfiable" },
    { status: 416, headers: { "Content-Range": `bytes */${size}` } }
  );
}

function buildObjectHeaders(source: ObjectStorageMetadata, contentType: string): Headers {
  const headers = new Headers();
  source.writeHttpMetadata(headers);
  headers.set("Content-Type", contentType);
  headers.set("ETag", source.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  return headers;
}
