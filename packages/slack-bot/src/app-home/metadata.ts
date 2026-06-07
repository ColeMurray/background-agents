export type BranchModalMetadata = {
  userId: string;
};

export type RepoBranchModalMetadata = BranchModalMetadata & {
  repoId: string;
};

export type RepoBranchModalMetadataDecodeResult =
  | { ok: true; metadata: RepoBranchModalMetadata }
  | { ok: false; reason: "missing" | "invalid_json" | "invalid_shape"; errorMessage?: string };

export function encodeBranchModalMetadata(metadata: BranchModalMetadata): string {
  return JSON.stringify(metadata);
}

export function encodeRepoBranchModalMetadata(metadata: RepoBranchModalMetadata): string {
  return JSON.stringify(metadata);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isRepoBranchModalMetadata(value: unknown): value is RepoBranchModalMetadata {
  return isRecord(value) && typeof value.userId === "string" && typeof value.repoId === "string";
}

export function decodeRepoBranchModalMetadata(
  metadataRaw: string | undefined
): RepoBranchModalMetadataDecodeResult {
  if (!metadataRaw) {
    return { ok: false, reason: "missing" };
  }

  try {
    const parsed: unknown = JSON.parse(metadataRaw);
    if (!isRepoBranchModalMetadata(parsed)) {
      return { ok: false, reason: "invalid_shape" };
    }

    return { ok: true, metadata: parsed };
  } catch (error) {
    return {
      ok: false,
      reason: "invalid_json",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}
