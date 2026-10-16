import { PGlite } from "@electric-sql/pglite";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

export interface SqlResult<Row> {
  readonly rows: Row[];
  readonly affectedRows?: number;
}

export interface SqlTransaction {
  query<Row>(sql: string, parameters?: readonly unknown[]): Promise<SqlResult<Row>>;
}

export interface SqlDatabase extends SqlTransaction {
  exec(sql: string): Promise<void>;
  transaction<Result>(operation: (transaction: SqlTransaction) => Promise<Result>): Promise<Result>;
  close(): Promise<void>;
}

class PGliteDatabase implements SqlDatabase {
  readonly #database: PGlite;

  public constructor(dataDirectory: string) {
    this.#database = new PGlite(dataDirectory);
  }

  public async query<Row>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlResult<Row>> {
    return this.#database.query<Row>(sql, [...parameters]);
  }

  public async exec(sql: string): Promise<void> {
    await this.#database.exec(sql);
  }

  public transaction<Result>(
    operation: (transaction: SqlTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.#database.transaction((transaction) =>
      operation({
        query: async <Row>(sql: string, parameters: readonly unknown[] = []) =>
          transaction.query<Row>(sql, [...parameters]),
      }),
    );
  }

  public async close(): Promise<void> {
    await this.#database.close();
  }
}

class PostgresTransaction implements SqlTransaction {
  public constructor(private readonly client: PoolClient) {}

  public async query<Row>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlResult<Row>> {
    const result = await this.client.query<QueryResultRow>(sql, [...parameters]);
    return { rows: result.rows as Row[], affectedRows: result.rowCount ?? 0 };
  }
}

class PostgresDatabase implements SqlDatabase {
  readonly #pool: Pool;

  public constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 10 });
  }

  public async query<Row>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlResult<Row>> {
    const result = await this.#pool.query<QueryResultRow>(sql, [...parameters]);
    return { rows: result.rows as Row[], affectedRows: result.rowCount ?? 0 };
  }

  public async exec(sql: string): Promise<void> {
    await this.#pool.query(sql);
  }

  public async transaction<Result>(
    operation: (transaction: SqlTransaction) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(new PostgresTransaction(client));
      await client.query("COMMIT");
      return result;
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async close(): Promise<void> {
    await this.#pool.end();
  }
}

export function createSqlDatabase(location: string): SqlDatabase {
  return /^postgres(?:ql)?:\/\//i.test(location)
    ? new PostgresDatabase(location)
    : new PGliteDatabase(location);
}
