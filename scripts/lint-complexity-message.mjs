const COMPLEXITY_MESSAGE_ID = "complex";
const COMPLEXITY_VALUE_PATTERN = /\bcomplexity of (\d+)\b/u;

export function parseComplexityMessage(file, message) {
  const match =
    message.messageId === COMPLEXITY_MESSAGE_ID
      ? COMPLEXITY_VALUE_PATTERN.exec(message.message)
      : null;

  if (!match) {
    throw new Error(`Could not parse complexity at ${file}:${message.line}:${message.column}`);
  }

  return {
    file,
    line: message.line,
    column: message.column,
    complexity: Number(match[1]),
    description: message.nodeType ?? "Function",
  };
}
