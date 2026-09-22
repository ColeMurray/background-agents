/** CLI only: orderly cleanup has finished, but abandoned application handles may remain. */
export function boundProcessExit(graceMs = 5_000): void {
  setTimeout(() => {
    console.error("shutdown: abandoned handles kept the preview process alive; forcing exit");
    process.exit(1);
  }, graceMs).unref();
}
