/**
 * Memory tools for OpenCode, built from the generated cross-harness specs.
 *
 * Not a tool (no default tool() export). `harness/memory_tools.py` builds the
 * Claude twins from the same specs with the same request and error semantics.
 * Arguments are forwarded verbatim after dropping keys the input schema does
 * not declare; the control plane derives identity and write authority.
 */
import { bridgeFetch, extractError } from "./_bridge-client.js";
import { MEMORY_CONTRACT } from "./_memory-contract.js";

function memoryToolSpec(name) {
  const spec = MEMORY_CONTRACT.tools.find((candidate) => candidate.name === name);
  if (!spec) throw new Error(`Unknown memory tool: ${name}`);
  return spec;
}

/** Convert one JSON Schema property (the subset the specs use) to a zod schema. */
function toArg(z, key, property, required) {
  let arg;
  switch (property.type) {
    case "string":
      arg = property.enum ? z.enum(property.enum) : z.string();
      if (property.minLength !== undefined) arg = arg.min(property.minLength);
      if (property.maxLength !== undefined) arg = arg.max(property.maxLength);
      break;
    case "integer":
      arg = z.number().int();
      if (property.minimum !== undefined) arg = arg.min(property.minimum);
      if (property.maximum !== undefined) arg = arg.max(property.maximum);
      break;
    default:
      throw new Error(`Unsupported memory tool argument type for ${key}: ${property.type}`);
  }
  if (property.default !== undefined) arg = arg.default(property.default);
  // optional() after default() keeps a defaulted field out of the provider-facing `required`.
  if (!required) arg = arg.optional();
  if (property.description !== undefined) arg = arg.describe(property.description);
  return arg;
}

/** OpenCode `args` for a tool's input schema; `z` is the plugin's `tool.schema`. */
export function memoryToolArgs(z, inputSchema) {
  const required = new Set(inputSchema.required ?? []);
  return Object.fromEntries(
    Object.entries(inputSchema.properties).map(([key, property]) => [
      key,
      toArg(z, key, property, required.has(key)),
    ])
  );
}

/** Call a memory endpoint through the session-scoped bridge, reporting failures as text. */
export async function executeMemoryTool(name, args) {
  const spec = memoryToolSpec(name);
  const body = Object.fromEntries(
    Object.keys(spec.inputSchema.properties)
      .filter((key) => args[key] !== undefined)
      .map((key) => [key, args[key]])
  );
  const path = spec.path.replace(/\{(\w+)\}/g, (_match, key) => {
    const value = body[key] ?? "";
    delete body[key];
    return encodeURIComponent(String(value));
  });
  let response;
  try {
    response = await bridgeFetch(
      path,
      spec.method === "GET"
        ? { method: "GET" }
        : { method: spec.method, body: JSON.stringify(body) }
    );
  } catch {
    // Transport details can name internal hosts; the agent only needs the outcome.
    return `${name} failed (unavailable)`;
  }
  if (!response.ok) return `${name} failed (${response.status}): ${await extractError(response)}`;
  return response.text();
}

/** The `tool()` input for one memory tool: spec description and args, generic executor. */
export function memoryToolDefinition(z, name) {
  const spec = memoryToolSpec(name);
  return {
    description: spec.description,
    args: memoryToolArgs(z, spec.inputSchema),
    execute: (args) => executeMemoryTool(name, args),
  };
}
