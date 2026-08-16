import {
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_REVISION_BYTES,
  type SessionSkillManifestSelection,
  type SkillAssignment,
  type SkillContentInput,
  type SkillFile,
} from "@open-inspect/shared/types/skills";

const encoder = new TextEncoder();
const REVISION_DOMAIN = encoder.encode("OPEN_INSPECT_SKILL_REVISION_V1\0");
const MANIFEST_DOMAIN = encoder.encode("OPEN_INSPECT_SKILL_MANIFEST_V1\0");

/**
 * Domain strings, field ordering, and resolver version define persisted IDs.
 * Incompatible serialization changes require new domains and a new version.
 */
export const SKILL_RESOLVER_VERSION = 1;

interface ManifestHashSkill {
  skillId: string;
  revisionId: string;
  name: string;
  revisionSha256: string;
  assignmentSources: SkillAssignment[];
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function renderSkillMarkdown(name: string, content: SkillContentInput): string {
  const lines = ["---", `name: ${name}`, `description: ${yamlString(content.description)}`];
  if (content.license) lines.push(`license: ${yamlString(content.license)}`);
  if (content.compatibility) {
    lines.push(`compatibility: ${yamlString(content.compatibility)}`);
  }
  const metadata = Object.entries(content.metadata).sort(([left], [right]) =>
    compareUtf8(left, right)
  );
  if (metadata.length > 0) {
    lines.push("metadata:");
    for (const [key, value] of metadata) {
      lines.push(`  ${yamlString(key)}: ${yamlString(value)}`);
    }
  }
  lines.push("---");
  return `${lines.join("\n")}\n${content.body}`;
}

async function sha256Hex(content: Uint8Array | string): Promise<string> {
  const bytes = typeof content === "string" ? encoder.encode(content) : content;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

function compareUtf8(left: string, right: string): number {
  return compareBytes(encoder.encode(left), encoder.encode(right));
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function u64(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}

function stringBytes(value: string): Uint8Array[] {
  const bytes = encoder.encode(value);
  return [u32(bytes.length), bytes];
}

function hexBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("Invalid SHA-256 digest");
  return Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

/** Render generated SKILL.md and hash the complete, byte-ordered revision tree. */
export async function buildSkillRevision(
  name: string,
  content: SkillContentInput
): Promise<{ files: SkillFile[]; revisionSha256: string; totalBytes: number }> {
  const sourceFiles = [
    { path: "SKILL.md", content: renderSkillMarkdown(name, content), executable: false },
    ...content.files,
  ].sort((left, right) => compareUtf8(left.path, right.path));
  const files = await Promise.all(
    sourceFiles.map(async (file) => {
      const sizeBytes = encoder.encode(file.content).byteLength;
      return {
        ...file,
        sha256: await sha256Hex(file.content),
        sizeBytes,
      };
    })
  );
  const parts = [REVISION_DOMAIN, u32(files.length)];
  for (const file of files) {
    const bytes = encoder.encode(file.content);
    parts.push(
      ...stringBytes(file.path),
      Uint8Array.of(file.executable ? 1 : 0),
      u64(bytes.length),
      bytes
    );
  }
  return {
    files,
    revisionSha256: await sha256Hex(concat(parts)),
    totalBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
  };
}

function sourceValues(source: SkillAssignment): [string, string, string, string, string, string] {
  if (source.type === "repository") {
    return [source.type, source.id, source.repoOwner, source.repoName, "", ""];
  }
  if (source.type === "environment") {
    return [source.type, source.id, "", "", source.environmentId, source.environmentName ?? ""];
  }
  return [source.type, source.id, "", "", "", ""];
}

/** Hash selection, pinned revisions, and assignment provenance in canonical byte order. */
export async function hashSessionSkillManifest(
  selection: SessionSkillManifestSelection,
  skills: readonly ManifestHashSkill[]
): Promise<string> {
  const selectionByte = selection.mode === "all" ? 0 : selection.mode === "none" ? 1 : 2;
  const parts = [MANIFEST_DOMAIN, u32(SKILL_RESOLVER_VERSION), Uint8Array.of(selectionByte)];
  if (selection.mode === "profile") {
    parts.push(...stringBytes(selection.profileId), ...stringBytes(selection.profileName));
  }
  const sortedSkills = [...skills].sort(
    (left, right) => compareUtf8(left.name, right.name) || compareUtf8(left.skillId, right.skillId)
  );
  parts.push(u32(sortedSkills.length));
  for (const skill of sortedSkills) {
    parts.push(
      ...stringBytes(skill.skillId),
      ...stringBytes(skill.revisionId),
      ...stringBytes(skill.name),
      hexBytes(skill.revisionSha256)
    );
    const sources = [...skill.assignmentSources].sort((left, right) => {
      const leftValues = sourceValues(left);
      const rightValues = sourceValues(right);
      for (let index = 0; index < leftValues.length; index++) {
        const compared = compareUtf8(leftValues[index], rightValues[index]);
        if (compared !== 0) return compared;
      }
      return 0;
    });
    parts.push(u32(sources.length));
    for (const source of sources) {
      for (const value of sourceValues(source)) parts.push(...stringBytes(value));
    }
  }
  return sha256Hex(concat(parts));
}

export class SkillRevisionValidationError extends Error {}

export async function buildValidatedSkillRevision(name: string, content: SkillContentInput) {
  const revision = await buildSkillRevision(name, content);
  const oversized = revision.files.find((file) => file.sizeBytes > MAX_SKILL_FILE_BYTES);
  if (oversized) {
    throw new SkillRevisionValidationError(`${oversized.path} exceeds the per-file size limit`);
  }
  if (revision.totalBytes > MAX_SKILL_REVISION_BYTES) {
    throw new SkillRevisionValidationError("Rendered skill exceeds the revision size limit");
  }
  return revision;
}
