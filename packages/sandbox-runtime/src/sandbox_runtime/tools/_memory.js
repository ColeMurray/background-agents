import { bridgeFetch, extractError } from "./_bridge-client.js";

export async function readMemory({ memoryId }) {
  const response = await bridgeFetch(`/sandbox-memory/${encodeURIComponent(memoryId)}`);
  if (!response.ok) return `Memory read failed: ${await extractError(response)}`;
  return JSON.stringify(await response.json());
}

export async function writeMemory(args) {
  const scope =
    args.scope === "repository"
      ? { type: "repository", repoOwner: args.repoOwner, repoName: args.repoName }
      : args.scope === "environment"
        ? { type: "environment", environmentId: args.environmentId }
        : { type: "personal" };
  const body = {
    scope,
    memoryType: args.memoryType,
    title: args.title,
    description: args.description,
    content: args.content,
    ...(args.supersedesMemoryId ? { supersedesMemoryId: args.supersedesMemoryId } : {}),
  };
  const response = await bridgeFetch("/sandbox-memory", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) return `Memory write failed: ${await extractError(response)}`;
  return JSON.stringify(await response.json());
}
