"use client";

import type { SkillImportPreviewResponse } from "@open-inspect/shared/types/skills";

/** Abbreviate a digest the way session provenance does elsewhere in the app. */
function shortDigest(digest: string): string {
  return digest.slice(0, 12);
}

export function SkillImportSourceSummary({
  source,
}: {
  source: SkillImportPreviewResponse["source"];
}) {
  return (
    <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[10rem_1fr]">
      <dt className="text-muted-foreground">Provider</dt>
      <dd className="font-mono text-foreground">{source.provider}</dd>
      <dt className="text-muted-foreground">Repository</dt>
      <dd className="font-mono text-foreground">
        {source.repoOwner}/{source.repoName}
        {source.subdirectory ? `/${source.subdirectory}` : ""}
      </dd>
      <dt className="text-muted-foreground">Ref</dt>
      <dd className="font-mono text-foreground">
        {source.resolvedRef}
        {source.requestedRef === null ? " (default branch)" : ""}
      </dd>
      <dt className="text-muted-foreground">Commit</dt>
      <dd className="font-mono text-foreground">{source.commitSha}</dd>
      <dt className="text-muted-foreground">Source digest</dt>
      <dd className="font-mono text-foreground">{shortDigest(source.sourceSha256)}</dd>
    </dl>
  );
}

/**
 * The reviewable result of an import: what would be stored, where it came
 * from, and what the mapping could not carry across.
 */
export function SkillImportReview({ preview }: { preview: SkillImportPreviewResponse }) {
  return (
    <div className="space-y-4 rounded border border-border-muted p-4">
      <div>
        <h4 className="text-sm font-medium text-foreground">Source</h4>
        <div className="mt-2">
          <SkillImportSourceSummary source={preview.source} />
        </div>
      </div>

      {preview.warnings.length > 0 && (
        <ul className="space-y-1 rounded bg-amber-500/10 p-3 text-xs text-foreground">
          {preview.warnings.map((warning) => (
            <li key={`${warning.code}:${warning.message}`}>{warning.message}</li>
          ))}
        </ul>
      )}

      {!preview.nameAvailable && (
        <p className="rounded bg-destructive/10 p-3 text-xs text-destructive">
          A skill named <span className="font-mono">{preview.name}</span> already exists. Names are
          permanent and stay taken after deletion — choose a different canonical name.
        </p>
      )}

      <div>
        <h4 className="text-sm font-medium text-foreground">
          Files ({preview.files.length}) · {preview.totalBytes.toLocaleString()} bytes · SHA-256{" "}
          <span className="font-mono">{shortDigest(preview.revisionSha256)}</span>
        </h4>
        <ul className="mt-2 divide-y divide-border-muted rounded border border-border-muted text-xs">
          {preview.files.map((file) => (
            <li key={file.path} className="px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <span className="truncate font-mono text-foreground">{file.path}</span>
                <span className="shrink-0 text-muted-foreground">
                  {file.executable && <span className="mr-2">executable</span>}
                  {file.sizeBytes.toLocaleString()} bytes
                </span>
              </div>
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-3">
                {file.content}
              </pre>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
