export interface ByteRange {
  start: number;
  end: number;
  length: number;
  totalSize: number;
}

export function parseByteRangeHeader(rangeHeader: string, size: number): ByteRange | null {
  if (!rangeHeader.startsWith("bytes=") || rangeHeader.includes(",")) return null;
  const parts = rangeHeader.slice("bytes=".length).trim().split("-");
  if (parts.length !== 2) return null;
  const [startRaw, endRaw] = parts;
  const isUnsignedDecimal = (value: string) => /^\d+$/.test(value);

  let start: number;
  let end: number;
  if (startRaw === "") {
    if (!isUnsignedDecimal(endRaw)) return null;
    const suffixLength = Number(endRaw);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    if (!isUnsignedDecimal(startRaw) || (endRaw !== "" && !isUnsignedDecimal(endRaw))) {
      return null;
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
    return null;
  }

  end = Math.min(end, size - 1);
  return { start, end, length: end - start + 1, totalSize: size };
}
