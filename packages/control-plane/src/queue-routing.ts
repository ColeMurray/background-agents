export function isAutofixQueue(queueName: string): boolean {
  return queueName.startsWith("open-inspect-github-autofix-");
}
