/**
 * Fake SQL storage for testing Durable Objects without real SQLite.
 */

type SQLValue = string | number | null | ArrayBuffer;
type SQLRow = Record<string, SQLValue>;

/**
 * Minimal fake implementation of DurableObjectStorage's SQL interface.
 * Stores data in memory as a simple object.
 */
export class FakeSqlStorage {
  private _tables: Map<string, Map<string, SQLRow>> = new Map();
  private _autoIncrementCounters: Map<string, number> = new Map();

  /**
   * Execute a SQL query.
   * Only supports basic INSERT, UPDATE, SELECT, DELETE operations.
   */
  exec(query: string, ...params: SQLValue[]): { toArray: () => SQLRow[] } {
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
      return { toArray: () => [] };
    }

    // CREATE INDEX - ignore for testing
    if (normalizedQuery.startsWith("create index")) {
      return { toArray: () => [] };
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
      return { toArray: () => [] };
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
      return { toArray: () => [] };
    }

    // SELECT - retrieve rows
    if (normalizedQuery.startsWith("select")) {
      const match = query.match(/from\s+(\w+)/i);
      if (match) {
        const tableName = match[1];
        const table = this._tables.get(tableName);
        if (!table) {
          return { toArray: () => [] };
        }

        let results = Array.from(table.values());
        let paramIndex = 0;

        // Handle COUNT(*) aggregation
        if (normalizedQuery.includes("count(*)")) {
          return { toArray: () => [{ count: results.length }] };
        }

        // Apply WHERE clause (basic support for "WHERE column = ?")
        if (normalizedQuery.includes("where")) {
          const whereMatch = query.match(/where\s+(\w+)\s*=\s*\?/i);
          if (whereMatch && params.length > paramIndex) {
            const column = whereMatch[1];
            const value = params[paramIndex++];
            results = results.filter((row) => row[column] === value);
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

        return { toArray: () => results };
      }
      return { toArray: () => [] };
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
      return { toArray: () => [] };
    }

    // ALTER TABLE - ignore for testing (migrations are idempotent)
    if (normalizedQuery.startsWith("alter table")) {
      return { toArray: () => [] };
    }

    return { toArray: () => [] };
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
