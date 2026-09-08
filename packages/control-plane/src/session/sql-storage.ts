/** Minimal Cloudflare SQL surface used by session persistence. */
export interface SqlStorage {
  exec(query: string, ...params: unknown[]): SqlResult;
}

export interface SqlResult {
  toArray(): unknown[];
  one(): unknown;
  readonly rowsRead?: number;
  readonly rowsWritten?: number;
}

export type TransactionSync = <T>(closure: () => T) => T;
