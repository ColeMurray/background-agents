import { MAX_WEB_PROMPT_CHARS } from "@open-inspect/shared/types/websocket";

export function getWebPromptLengthError(content: string): string | null {
  return content.length > MAX_WEB_PROMPT_CHARS
    ? `Prompt must be ${MAX_WEB_PROMPT_CHARS.toLocaleString()} characters or fewer`
    : null;
}
