export const WORKSPACE_MAX_PATH_BYTES = 4_096;
export const WORKSPACE_MAX_PATH_SEGMENTS = 128;
export const WORKSPACE_MAX_EDIT_COUNT = 100;
export const WORKSPACE_MAX_STRUCTURAL_BYTES = 2 * 1024 * 1024;
export const WORKSPACE_MAX_QUERY_BYTES = 16 * 1024;
export const WORKSPACE_MAX_GLOB_BYTES = 4_096;
export const WORKSPACE_MAX_GLOB_COUNT = 32;
export const WORKSPACE_MAX_QUERY_OFFSET = 1_000_000;

/** Reject attacker-sized tool arguments before Computer allocates, parses, or touches VFS. */
export function validateWorkspaceToolInput(
  tool: string,
  value: unknown,
  parameters?: { required?: string[] }
): Record<string, unknown> {
  const normalized = prepareWorkspaceToolArguments(tool, value, parameters);
  const path = normalized.path;
  if (typeof path === "string") validatePath(path);
  if (normalized.offset !== undefined) validateOffset(normalized.offset);
  if (tool === "write")
    validateBoundedString(normalized.content, WORKSPACE_MAX_STRUCTURAL_BYTES, "content");
  if (tool === "edit") validateEdits(normalized);
  if (tool === "find") {
    validateBoundedString(normalized.pattern, WORKSPACE_MAX_GLOB_BYTES, "pattern");
    validateGlobs(normalized.exclude, "exclude");
  }
  if (tool === "grep") {
    validateBoundedString(normalized.query, WORKSPACE_MAX_QUERY_BYTES, "query");
    if (normalized.regex === true) {
      throw new Error("Workspace grep regular expressions are disabled; use literal search");
    }
    validateGlobs(normalized.include, "include");
    validateGlobs(normalized.exclude, "exclude");
  }
  return normalized;
}

/** Computer-compatible argument repair that runs before Pi's strict schema validation. */
export function prepareWorkspaceToolArguments(
  tool: string,
  value: unknown,
  parameters?: { required?: string[] }
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Workspace ${tool} arguments must be an object`);
  if (typeof value.path === "string") validatePath(value.path);
  const normalized = dropOptionalNulls(value, parameters?.required ?? []);
  if (tool === "edit") normalizeLegacyEdits(normalized);
  return normalized;
}

function validatePath(path: string): void {
  const repository = path.match(/^\/workspace\/repos\/([0-9]+)(?:\/(.*))?$/s);
  if (repository) {
    if (repository[1].length > 10 || !Number.isSafeInteger(Number(repository[1]))) {
      throw new Error("Workspace repository position is invalid");
    }
    validateBoundedString(repository[2] ?? "", WORKSPACE_MAX_PATH_BYTES, "path");
    validatePathSegments(repository[2] ?? "");
    return;
  }
  validateBoundedString(path, WORKSPACE_MAX_PATH_BYTES, "path");
  validatePathSegments(path);
}

function validatePathSegments(path: string): void {
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.length > WORKSPACE_MAX_PATH_SEGMENTS) {
    throw new Error(`Workspace path exceeds ${WORKSPACE_MAX_PATH_SEGMENTS} segments`);
  }
}

function validateEdits(args: Record<string, unknown>): void {
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (edits.length === 0) throw new Error("Workspace edits must contain a replacement");
  if (edits.length > WORKSPACE_MAX_EDIT_COUNT) {
    throw new Error(`Workspace edit count exceeds ${WORKSPACE_MAX_EDIT_COUNT}`);
  }
  let characters = 0;
  const texts: string[] = [];
  for (const edit of edits) {
    if (!isRecord(edit) || typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
      throw new Error("Workspace edit arguments are invalid");
    }
    characters += edit.oldText.length + edit.newText.length;
    if (characters > WORKSPACE_MAX_STRUCTURAL_BYTES) {
      throw new Error("Workspace edit structural bytes exceed the configured limit");
    }
    texts.push(edit.oldText, edit.newText);
  }
  let bytes = 0;
  for (const text of texts) {
    bytes += new TextEncoder().encode(text).byteLength;
    if (bytes > WORKSPACE_MAX_STRUCTURAL_BYTES) {
      throw new Error("Workspace edit structural bytes exceed the configured limit");
    }
  }
}

function normalizeLegacyEdits(args: Record<string, unknown>): void {
  let edits = args.edits;
  if (typeof edits === "string") {
    validateBoundedString(edits, WORKSPACE_MAX_STRUCTURAL_BYTES, "packed edits");
    try {
      const parsed: unknown = JSON.parse(edits);
      if (Array.isArray(parsed)) edits = parsed;
    } catch {
      // Computer falls back to root oldText/newText when packed edits are malformed.
    }
  }
  const normalized = Array.isArray(edits) ? [...edits] : [];
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    normalized.push({ oldText: args.oldText, newText: args.newText });
  }
  args.edits = normalized;
  delete args.oldText;
  delete args.newText;
}

function dropOptionalNulls(
  value: Record<string, unknown>,
  required: readonly string[]
): Record<string, unknown> {
  const requiredNames = new Set(required);
  return Object.fromEntries(
    Object.entries(value).filter(([name, field]) => field !== null || requiredNames.has(name))
  );
}

function validateGlobs(value: unknown, name: string): void {
  if (value === undefined || value === null) return;
  const globs = typeof value === "string" ? [value] : value;
  if (!Array.isArray(globs) || globs.length > WORKSPACE_MAX_GLOB_COUNT) {
    throw new Error(`Workspace ${name} exceeds ${WORKSPACE_MAX_GLOB_COUNT} patterns`);
  }
  for (const glob of globs)
    validateBoundedString(glob, WORKSPACE_MAX_GLOB_BYTES, `${name} pattern`);
}

function validateOffset(value: unknown): void {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > WORKSPACE_MAX_QUERY_OFFSET
  ) {
    throw new Error(`Workspace offset must be between 0 and ${WORKSPACE_MAX_QUERY_OFFSET}`);
  }
}

function validateBoundedString(
  value: unknown,
  maxBytes: number,
  name: string
): asserts value is string {
  if (typeof value !== "string") throw new Error(`Workspace ${name} must be a string`);
  // UTF-8 cannot use fewer bytes than UTF-16 code units for these bounds.
  if (value.length > maxBytes || new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new Error(`Workspace ${name} is too large (limit ${maxBytes} UTF-8 bytes)`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
