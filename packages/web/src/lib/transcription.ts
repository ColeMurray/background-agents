export function appendTranscript(draft: string, transcript: string) {
  const nextText = transcript.trim();
  if (!nextText) return draft;

  const currentText = draft.trimEnd();
  return currentText ? `${currentText} ${nextText}` : nextText;
}
