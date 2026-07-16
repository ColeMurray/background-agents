import type { ObjectStorage, ObjectStorageMetadata } from "../storage/object-storage";

export interface StreamStoredMediaOptions {
  request: Request;
  storage: ObjectStorage;
  objectKey: string;
  fallbackContentType?: string | null;
  isAllowedContentType: (contentType: string) => boolean;
  notFound: () => Response;
  invalidMetadata: (contentType: string | null) => Response;
}

/** Canonical GET/range/metadata flow for objects stored in the media bucket. */
export async function streamStoredMedia(options: StreamStoredMediaOptions): Promise<Response> {
  const rangeHeader = options.request.headers.get("Range");
  if (rangeHeader) {
    const head = await options.storage.head(options.objectKey);
    if (!head) return options.notFound();

    const range = parseByteRangeHeader(rangeHeader, head.size);
    if (range instanceof Response) return range;
    const object = await options.storage.get(options.objectKey, {
      range: { offset: range.start, length: range.length },
    });
    if (!object) return options.notFound();

    const headers = buildMediaHeaders(head, options);
    if (headers instanceof Response) return headers;
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${head.size}`);
    headers.set("Content-Length", String(range.length));
    return new Response(object.body, { status: 206, headers });
  }

  const object = await options.storage.get(options.objectKey);
  if (!object) return options.notFound();
  const headers = buildMediaHeaders(object, options);
  if (headers instanceof Response) return headers;
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}

function buildMediaHeaders(
  source: ObjectStorageMetadata,
  options: StreamStoredMediaOptions
): Headers | Response {
  const headers = new Headers();
  source.writeHttpMetadata(headers);
  const storedContentType = headers.get("Content-Type");
  const contentType =
    storedContentType && options.isAllowedContentType(storedContentType)
      ? storedContentType
      : options.fallbackContentType;
  if (!contentType || !options.isAllowedContentType(contentType)) {
    return options.invalidMetadata(storedContentType);
  }
  headers.set("Content-Type", contentType);
  headers.set("ETag", source.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  return headers;
}

export function parseByteRangeHeader(
  rangeHeader: string,
  size: number
): { start: number; end: number; length: number } | Response {
  const unsatisfied = () =>
    Response.json(
      { error: "Requested range is not satisfiable" },
      { status: 416, headers: { "Content-Range": `bytes */${size}` } }
    );

  if (!rangeHeader.startsWith("bytes=") || rangeHeader.includes(",")) return unsatisfied();
  const parts = rangeHeader.slice("bytes=".length).trim().split("-");
  if (parts.length !== 2) return unsatisfied();
  const [startRaw, endRaw] = parts;
  const isUnsignedDecimal = (value: string) => /^\d+$/.test(value);

  let start: number;
  let end: number;
  if (startRaw === "") {
    if (!isUnsignedDecimal(endRaw)) return unsatisfied();
    const suffixLength = Number(endRaw);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return unsatisfied();
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    if (!isUnsignedDecimal(startRaw) || (endRaw !== "" && !isUnsignedDecimal(endRaw))) {
      return unsatisfied();
    }
    start = Number(startRaw);
    end = endRaw === "" ? size - 1 : Number(endRaw);
  }
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return unsatisfied();
  }
  end = Math.min(end, size - 1);
  return { start, end, length: end - start + 1 };
}
