/**
 * Tool call persistence status helpers.
 */

export function shouldPersistToolCallEvent(status: string | null | undefined): boolean {
  const normalizedStatus = typeof status === "string" ? status.trim() : status;
  return (
    normalizedStatus == null ||
    normalizedStatus === "" ||
    normalizedStatus === "completed" ||
    normalizedStatus === "error"
  );
}
