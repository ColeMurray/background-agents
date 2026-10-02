export function findSessionCompletion(value: string, start: number, end: number) {
  if (start !== end) return null;
  const match = /(?:^|\s)#([^\s#[\]]*)$/.exec(value.slice(0, start));
  return match ? { start: start - match[1].length - 1, end: start, query: match[1] } : null;
}
