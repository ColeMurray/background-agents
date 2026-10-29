import { ModelProviderAccountBrokerError } from "./model-provider-account-broker";

/** Stop waiting, not the durable commit of an already-consumed rotating grant. */
export async function withinProviderAccessDeadline<T>(
  operation: Promise<T>,
  deadlineAt?: number
): Promise<T> {
  if (deadlineAt === undefined) return operation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ModelProviderAccountBrokerError(
                "deadline_exceeded",
                "Provider access deadline exceeded"
              )
            ),
          Math.max(0, deadlineAt - Date.now())
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
