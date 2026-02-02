/**
 * Fake SQL storage for testing Durable Objects without real SQLite.
 */

type SQLValue = SqlStorageValue;
type SQLRow = Record<string, SQLValue>;

class FakeSqlStorageCursor<T extends SQLRow> implements SqlStorageCursor<T> {
  columnNames: string[];
  private rows: T[];
  private index = 0;

  constructor(rows: T[]) {
    this.rows = rows;
    this.columnNames = rows.length > 0 ? Object.keys(rows[0]) : [];
  }

  next(): { done?: false; value: T } | { done: true; value?: never } {
    if (this.index >= this.rows.length) {
      return { done: true };
    }
    const value = this.rows[this.index++];
    return { done: false, value };
  }

  toArray(): T[] {
    return [...this.rows];
  }

  one(): T {
    if (this.rows.length === 0) {
      throw new Error("No rows available");
    }
    return this.rows[0];
  }

  raw<U extends SQLValue[]>(): IterableIterator<U> {
    const rows = this.rows.map((row) => Object.values(row) as U);
    return rows[Symbol.iterator]();
  }

  get rowsRead(): number {
    return this.rows.length;
  }

  get rowsWritten(): number {
    return 0;
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.rows[Symbol.iterator]();
  }
}

class FakeSqlStorageStatement extends SqlStorageStatement {}

/**
 * Minimal fake implementation of DurableObjectStorage's SQL interface.
 * Stores data in memory as a simple object.
 */
export class FakeSqlStorage {
  databaseSize = 0;
  Cursor = FakeSqlStorageCursor as unknown as typeof SqlStorageCursor;
  Statement = FakeSqlStorageStatement as unknown as typeof SqlStorageStatement;
  private _tables: Map<string, Map<string, SQLRow>> = new Map();
  private _autoIncrementCounters: Map<string, number> = new Map();

  /**
   * Execute a SQL query.
   * Only supports basic INSERT, UPDATE, SELECT, DELETE operations.
   */
  exec<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...params: SQLValue[]
  ): FakeSqlStorageCursor<T> {
    const normalizedQuery = query.trim().toLowerCase();

    // CREATE TABLE - extract table name and store empty map
    if (normalizedQuery.startsWith("create table")) {
      const match = query.match(/create\s+table\s+(?:if\s+not\s+exists\s+)?(\w+)/i);
      if (match) {
        const tableName = match[1];
        if (!this._tables.has(tableName)) {
          this._tables.set(tableName, new Map());
        }
      }
      return new FakeSqlStorageCursor([] as T[]);
    }

    // CREATE INDEX - ignore for testing
    if (normalizedQuery.startsWith("create index")) {
      return new FakeSqlStorageCursor([] as T[]);
    }

    // INSERT - store row
    if (normalizedQuery.startsWith("insert into")) {
      const match = query.match(/insert\s+into\s+(\w+)/i);
      if (match) {
        const tableName = match[1];
        const table = this._tables.get(tableName) || new Map();
        this._tables.set(tableName, table);

        // Extract column names from query
        const columnsMatch = query.match(/\(([^)]+)\)\s+VALUES/i);
        const columns = columnsMatch ? columnsMatch[1].split(",").map((c) => c.trim()) : [];

        const row: SQLRow = {};
        columns.forEach((col, index) => {
          row[col] = params[index] ?? null;
        });

        // Use first column as ID
        const id = row[columns[0]] as string;
        table.set(id, row);
      }
      return new FakeSqlStorageCursor([] as T[]);
    }

    // UPDATE - modify existing row
    if (normalizedQuery.startsWith("update")) {
      const match = query.match(/update\s+(\w+)/i);
      if (match) {
        const tableName = match[1];
        const table = this._tables.get(tableName);
        if (table) {
          const setMatch = query.match(/set\s+(.+?)\s+where/i);
          if (setMatch) {
            // Parse SET clause to extract column assignments
            const setClause = setMatch[1];
            const assignments = setClause.split(",").map((s) => s.trim());

            const updates: Record<string, SQLValue> = {};
            let paramIndex = 0;

            assignments.forEach((assignment) => {
              const eqIndex = assignment.indexOf("=");
              if (eqIndex > 0) {
                const column = assignment.substring(0, eqIndex).trim();
                const valuePart = assignment.substring(eqIndex + 1).trim();

                if (valuePart === "?") {
                  updates[column] = params[paramIndex++];
                }
              }
            });

            // Parse WHERE clause
            const whereMatch = query.match(/where\s+(\w+)\s*=\s*\?/i);
            if (whereMatch) {
              const column = whereMatch[1];
              const value = params[paramIndex];
              table.forEach((row) => {
                if (row[column] === value) {
                  Object.assign(row, updates);
                }
              });
            }
          } else {
            // No WHERE clause - update all rows
            const setOnlyMatch = query.match(/set\s+(.+?)$/i);
            if (setOnlyMatch) {
              const setClause = setOnlyMatch[1];
              const assignments = setClause.split(",").map((s) => s.trim());

              const updates: Record<string, SQLValue> = {};
              let paramIndex = 0;

              assignments.forEach((assignment) => {
                const eqIndex = assignment.indexOf("=");
                if (eqIndex > 0) {
                  const column = assignment.substring(0, eqIndex).trim();
                  updates[column] = params[paramIndex++];
                }
              });

              table.forEach((row) => {
                Object.assign(row, updates);
              });
            }
          }
        }
      }
      return new FakeSqlStorageCursor([] as T[]);
    }

    // SELECT - retrieve rows
    if (normalizedQuery.startsWith("select")) {
      const match = query.match(/from\s+(\w+)/i);
      if (match) {
        const tableName = match[1];
        const table = this._tables.get(tableName);
        if (!table) {
          return new FakeSqlStorageCursor([] as T[]);
        }

        let results = Array.from(table.values());
        let paramIndex = 0;

        // Handle COUNT(*) aggregation
        if (normalizedQuery.includes("count(*)")) {
          return new FakeSqlStorageCursor([{ count: results.length }] as unknown as T[]);
        }

        // Apply WHERE clause
        if (normalizedQuery.includes("where")) {
          // Handle multiple WHERE conditions with AND
          const whereClause = query.match(
            /where\s+(.+?)(?:\s+order\s+by|\s+limit|\s+offset|$)/i
          )?.[1];
          if (whereClause) {
            const conditions = whereClause.split(/\s+and\s+/i);

            conditions.forEach((condition) => {
              // Handle IN clause: "column IN (?, ?, ?)"
              const inMatch = condition.match(/(\w+)\s+in\s+\(([?',\s]+)\)/i);
              if (inMatch) {
                const column = inMatch[1];
                const placeholderCount = (inMatch[2].match(/\?/g) || []).length;
                const values = params.slice(paramIndex, paramIndex + placeholderCount);
                paramIndex += placeholderCount;
                results = results.filter((row) => values.includes(row[column]));
                return;
              }

              // Handle simple equality: "column = ?"
              const eqMatch = condition.match(/(\w+)\s*=\s*\?/i);
              if (eqMatch && params.length > paramIndex) {
                const column = eqMatch[1];
                const value = params[paramIndex++];
                results = results.filter((row) => row[column] === value);
              }
            });
          }
        }

        // Apply ORDER BY (basic support for single column ASC/DESC)
        if (normalizedQuery.includes("order by")) {
          const orderMatch = query.match(/order\s+by\s+(\w+)(?:\s+(asc|desc))?/i);
          if (orderMatch) {
            const column = orderMatch[1];
            const direction = orderMatch[2]?.toLowerCase() === "desc" ? -1 : 1;
            results.sort((a, b) => {
              const aVal = a[column] ?? 0;
              const bVal = b[column] ?? 0;
              if (aVal < bVal) return -1 * direction;
              if (aVal > bVal) return 1 * direction;
              return 0;
            });
          }
        }

        // Apply LIMIT
        let limit: number | null = null;
        if (normalizedQuery.includes("limit")) {
          const limitMatch = query.match(/limit\s+\?/i);
          if (limitMatch && params.length > paramIndex) {
            limit = params[paramIndex++] as number;
          } else {
            const limitNumMatch = query.match(/limit\s+(\d+)/i);
            if (limitNumMatch) {
              limit = parseInt(limitNumMatch[1], 10);
            }
          }
        }

        // Apply OFFSET
        let offset = 0;
        if (normalizedQuery.includes("offset")) {
          const offsetMatch = query.match(/offset\s+\?/i);
          if (offsetMatch && params.length > paramIndex) {
            offset = params[paramIndex++] as number;
          } else {
            const offsetNumMatch = query.match(/offset\s+(\d+)/i);
            if (offsetNumMatch) {
              offset = parseInt(offsetNumMatch[1], 10);
            }
          }
        }

        // Apply pagination
        if (offset > 0) {
          results = results.slice(offset);
        }
        if (limit !== null) {
          results = results.slice(0, limit);
        }

        return new FakeSqlStorageCursor(results as unknown as T[]);
      }
      return new FakeSqlStorageCursor([] as T[]);
    }

    // DELETE - remove rows
    if (normalizedQuery.startsWith("delete from")) {
      const match = query.match(/delete\s+from\s+(\w+)/i);
      if (match) {
        const tableName = match[1];
        const table = this._tables.get(tableName);
        if (table) {
          if (normalizedQuery.includes("where")) {
            const whereMatch = query.match(/where\s+(\w+)\s*=\s*\?/i);
            if (whereMatch && params.length > 0) {
              const column = whereMatch[1];
              const value = params[0];
              const toDelete: string[] = [];
              table.forEach((row, id) => {
                if (row[column] === value) {
                  toDelete.push(id);
                }
              });
              toDelete.forEach((id) => table.delete(id));
            }
          } else {
            table.clear();
          }
        }
      }
      return new FakeSqlStorageCursor([] as T[]);
    }

    // ALTER TABLE - ignore for testing (migrations are idempotent)
    if (normalizedQuery.startsWith("alter table")) {
      return new FakeSqlStorageCursor([] as T[]);
    }

    return new FakeSqlStorageCursor([] as T[]);
  }

  /**
   * Clear all stored data.
   */
  clear(): void {
    this._tables.clear();
    this._autoIncrementCounters.clear();
  }

  /**
   * Get all data from a table (for testing assertions).
   */
  getTable(tableName: string): SQLRow[] {
    const table = this._tables.get(tableName);
    return table ? Array.from(table.values()) : [];
  }
}
