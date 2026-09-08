/**
 * Engine query limits shared by the src/db stores.
 *
 * Kept out of sql-database.ts on purpose: that port is types-only and erased
 * at build time, so it cannot hold runtime values.
 */

/**
 * Maximum bound parameters in a single statement. This is D1's documented
 * ceiling and the floor across supported engines, so stores that build
 * `IN (?, ?, …)` from a caller-sized list must chunk by it rather than assume
 * the list is short. Unchunked queries fail outright, they do not degrade.
 */
export const MAX_D1_QUERY_PARAMETERS = 100;
