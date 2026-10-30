/** Worker binding `PROVIDER_ACCOUNT_RANDOM_ENABLED`. Only the exact string enables random allocation. */
export function providerAccountRandomEnabled(value: string | undefined): boolean {
  return value === "true";
}
