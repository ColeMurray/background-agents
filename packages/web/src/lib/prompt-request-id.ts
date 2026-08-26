export type PromptRequestIdentity = {
  signature: string;
  clientRequestId: string;
};

export function promptRequestSignature(input: {
  content: string;
  model: string;
  reasoningEffort?: string;
  attachmentIds: string[];
}): string {
  return JSON.stringify(input);
}

export function resolvePromptRequestIdentity(
  signature: string,
  previous: PromptRequestIdentity | null
): PromptRequestIdentity {
  return previous?.signature === signature
    ? previous
    : { signature, clientRequestId: crypto.randomUUID() };
}
