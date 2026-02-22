import type { SlashTokenContext } from "./composer-slash-grammar";

export interface ComposerInsertResult {
  text: string;
  caretIndex: number;
}

export function replaceActiveSlashToken(input: {
  text: string;
  context: SlashTokenContext;
  template: string;
}): ComposerInsertResult {
  const template = input.template.trim();
  const before = input.text.slice(0, input.context.start);
  const after = input.text.slice(input.context.end);
  const text = `${before}${template}${after}`;

  return {
    text,
    caretIndex: before.length + template.length,
  };
}

export function appendTemplateToComposer(input: {
  text: string;
  template: string;
}): ComposerInsertResult {
  const template = input.template.trim();
  if (!template) {
    return { text: input.text, caretIndex: input.text.length };
  }

  if (!input.text.trim()) {
    return {
      text: template,
      caretIndex: template.length,
    };
  }

  const separator = input.text.endsWith("\n") ? "\n" : "\n\n";
  const text = `${input.text}${separator}${template}`;
  return {
    text,
    caretIndex: text.length,
  };
}
