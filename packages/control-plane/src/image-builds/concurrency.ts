/** Provider calls allowed in flight during one maintenance phase. */
const IMAGE_BUILD_MAINTENANCE_CONCURRENCY = 4;

/** Run every task while bounding provider and D1 fan-out. */
export async function runMaintenanceTasks<T>(
  items: readonly T[],
  task: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  let firstError: unknown;
  let hasError = false;
  const worker = async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      try {
        await task(item);
      } catch (error) {
        if (!hasError) {
          firstError = error;
          hasError = true;
        }
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(IMAGE_BUILD_MAINTENANCE_CONCURRENCY, items.length) }, async () =>
      worker()
    )
  );
  if (hasError) throw firstError;
}
