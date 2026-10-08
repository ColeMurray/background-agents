import { describe, expect, it } from "vitest";
import {
  GENERATED_FILE_MAX_BYTES,
  GENERATED_FILE_MAX_CAPTION_CHARS,
  formatGeneratedFileDisposition,
  generatedFileFilenameSchema,
  getGeneratedFileMimeType,
  normalizeGeneratedFileFilename,
  parseGeneratedFileDisposition,
} from "./generated-files";
import {
  generatedFileArtifactInfoSchema,
  generatedFileArtifactMetadataSchema,
  getResponseFileArtifacts,
  listArtifactsResponseSchema,
  type MediaArtifactInfo,
} from "./types/artifacts";
import { generatedFileUploadResponseSchema } from "./types/session-api";

const fileMetadata = {
  objectKey: "sessions/s1/files/f1",
  filename: "report.csv",
  mimeType: "text/csv",
  sizeBytes: 123,
  messageId: "m1",
};

describe("generated filenames and download headers", () => {
  it("normalizes user input while requiring canonical persisted names", () => {
    expect(normalizeGeneratedFileFilename("  cafe\u0301.CSV  ")).toBe("café.CSV");
    expect(generatedFileFilenameSchema.safeParse(" cafe\u0301.csv ").success).toBe(false);
  });

  it.each([
    "",
    " ",
    ".",
    "..",
    "a/b.csv",
    "a\\b.csv",
    "a\n.csv",
    "report.csv\n",
    "\treport.csv",
    "a\0.csv",
    "a\u007f.csv",
    "\ud800.csv",
  ])("rejects an unsafe filename %j", (filename) =>
    expect(() => normalizeGeneratedFileFilename(filename)).toThrow()
  );

  it("bounds UTF-8 bytes rather than UTF-16 length", () => {
    expect(normalizeGeneratedFileFilename(`${"é".repeat(125)}.csv`)).toHaveLength(129);
    expect(() => normalizeGeneratedFileFilename(`${"é".repeat(126)}.csv`)).toThrow();
    expect(normalizeGeneratedFileFilename("a".repeat(255))).toHaveLength(255);
    expect(() => normalizeGeneratedFileFilename("a".repeat(256))).toThrow();
  });

  it.each(["report.csv", 'Revenue "Q1"; 100%.csv', "日本語😀.xlsx", "résumé (final)'!.pdf"])(
    "round-trips an attachment filename %j without raw Unicode in headers",
    (filename) => {
      const header = formatGeneratedFileDisposition(filename);
      expect(header.startsWith('attachment; filename="')).toBe(true);
      expect(Array.from(header).every((char) => char.charCodeAt(0) < 128)).toBe(true);
      expect(parseGeneratedFileDisposition(header)).toBe(filename);
      expect(new Headers({ "Content-Disposition": header }).get("Content-Disposition")).toBe(
        header
      );
    }
  );

  it("escapes quotes and RFC 5987 characters", () => {
    expect(formatGeneratedFileDisposition('report "Q1".csv')).toContain(
      'filename="report \\"Q1\\".csv"'
    );
    expect(formatGeneratedFileDisposition("report'().csv")).toContain("report%27%28%29.csv");
  });

  it.each([
    'inline; filename="report.csv"',
    "attachment; filename=\"report.csv\"; filename*=UTF-8''%ZZ",
    "attachment; filename=\"other.csv\"; filename*=UTF-8''report.csv",
    "attachment; filename=\"report.csv\"; filename*=UTF-8''..%2Freport.csv",
    "attachment; filename=\"report.csv\"; filename*=UTF-8''report%0A.csv",
    'attachment; filename="report.csv"; filename*=UTF-8\'\'report.csv; filename="evil.csv"',
  ])("rejects malformed or inconsistent download headers %j", (header) => {
    expect(parseGeneratedFileDisposition(header)).toBeNull();
  });
});

describe("generated file contracts", () => {
  it.each([
    ["report.CSV", "text/csv"],
    ["report.tsv", "text/tab-separated-values"],
    ["readme.txt", "text/plain"],
    ["readme.md", "text/markdown"],
    ["data.json", "application/json"],
    ["report.pdf", "application/pdf"],
    ["report.zip", "application/zip"],
    ["report.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["data.custom", "application/octet-stream"],
    ["csv", "application/octet-stream"],
    ["data.toString", "application/octet-stream"],
  ])("uses a canonical MIME hint for %s", (filename, mimeType) => {
    expect(getGeneratedFileMimeType(filename)).toBe(mimeType);
    expect(
      generatedFileArtifactMetadataSchema.safeParse({ ...fileMetadata, filename, mimeType }).success
    ).toBe(true);
  });

  it("accepts strict metadata and bounded captions", () => {
    expect(generatedFileArtifactMetadataSchema.parse(fileMetadata)).toEqual(fileMetadata);
    expect(
      generatedFileArtifactMetadataSchema.safeParse({
        ...fileMetadata,
        caption: "a".repeat(GENERATED_FILE_MAX_CAPTION_CHARS),
      }).success
    ).toBe(true);
    expect(
      generatedFileArtifactMetadataSchema.safeParse({
        ...fileMetadata,
        caption: "a".repeat(GENERATED_FILE_MAX_CAPTION_CHARS + 1),
      }).success
    ).toBe(false);
    expect(
      generatedFileArtifactMetadataSchema.safeParse({ ...fileMetadata, channel: "C1" }).success
    ).toBe(false);
    expect(
      generatedFileArtifactMetadataSchema.safeParse({ ...fileMetadata, mimeType: "text/html" })
        .success
    ).toBe(false);
    expect(
      generatedFileArtifactMetadataSchema.safeParse({ ...fileMetadata, messageId: "" }).success
    ).toBe(false);
    expect(
      generatedFileArtifactMetadataSchema.safeParse({
        ...fileMetadata,
        objectKey: "sessions/s1/media/f1.csv",
      }).success
    ).toBe(false);
  });

  it.each([0, -1, 0.5, NaN, Infinity, GENERATED_FILE_MAX_BYTES + 1, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid actual byte size %s",
    (sizeBytes) => {
      expect(
        generatedFileArtifactMetadataSchema.safeParse({ ...fileMetadata, sizeBytes }).success
      ).toBe(false);
      expect(
        generatedFileUploadResponseSchema.safeParse({
          artifactId: "f1",
          filename: "report.csv",
          mimeType: "text/csv",
          sizeBytes,
        }).success
      ).toBe(false);
    }
  );

  it("validates upload responses without exposing storage metadata", () => {
    const response = {
      artifactId: "f1",
      filename: "report.csv",
      mimeType: "text/csv",
      sizeBytes: GENERATED_FILE_MAX_BYTES,
    };
    expect(generatedFileUploadResponseSchema.parse(response)).toEqual(response);
    expect(
      generatedFileUploadResponseSchema.safeParse({ ...response, mimeType: "video/mp4" }).success
    ).toBe(false);
    expect(
      generatedFileUploadResponseSchema.safeParse({
        ...response,
        objectKey: fileMetadata.objectKey,
      }).success
    ).toBe(false);
    expect(
      generatedFileUploadResponseSchema.safeParse({ ...response, artifactId: "" }).success
    ).toBe(false);
  });

  it("distinguishes unavailable references and accepts file artifact list rows", () => {
    expect(
      generatedFileArtifactInfoSchema.parse({ id: "f1", type: "file", available: false })
    ).toEqual({ id: "f1", type: "file", available: false });
    expect(
      generatedFileArtifactInfoSchema.safeParse({ id: "f1", type: "file", available: true }).success
    ).toBe(false);
    expect(
      listArtifactsResponseSchema.safeParse({
        artifacts: [
          {
            id: "f1",
            type: "file",
            url: fileMetadata.objectKey,
            metadata: fileMetadata,
            createdAt: 1,
          },
        ],
      }).success
    ).toBe(true);
  });

  it("uses canonical presence, including empty collections, without duplicating legacy media", () => {
    const mediaArtifacts: MediaArtifactInfo[] = [{ id: "screenshot-1", type: "screenshot" }];
    expect(getResponseFileArtifacts({ mediaArtifacts })).toBe(mediaArtifacts);
    const fileArtifacts = [
      { id: "f1", type: "file", available: false } as const,
      ...mediaArtifacts,
    ];
    expect(getResponseFileArtifacts({ fileArtifacts, mediaArtifacts })).toBe(fileArtifacts);
    expect(getResponseFileArtifacts({ fileArtifacts: [], mediaArtifacts })).toEqual([]);
  });
});
